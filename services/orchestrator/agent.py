import asyncio
import json
from typing import TypedDict
import uuid
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command, interrupt

from shared.contracts import AgentPlan, Decision, Legality, Offer, Source
from services.orchestrator.budget import budgets, reference_estimates
from services.orchestrator.checkpoints import DatabaseSaver
from services.orchestrator.suppliers import SupplierError
from services.orchestrator.progress import progress
from services.orchestrator.trace import tool_start, tool_end, event_writer
from services.orchestrator.exchange import exchange_rates


class State(TypedDict, total=False):
    request: str
    images: list
    history: list
    preferences: dict
    knowledge: dict
    plan: dict
    legality: dict
    offers: list
    supplier_errors: list
    budget: dict
    question: dict
    consent: dict
    deck_approval: dict
    event: dict
    cancelled: bool


class DeckAgent:
    def __init__(self, repo, planner, suppliers, exchange=None):
        self.repo, self.planner, self.suppliers = repo, planner, suppliers
        self.exchange = exchange or exchange_rates
        builder = StateGraph(State)
        for name in ("understand", "clarify", "validate", "review", "quote", "missing", "decide", "finish"):
            builder.add_node(name, getattr(self, name))
        builder.add_edge(START, "understand")
        builder.add_conditional_edges("understand", lambda state:"clarify" if state["plan"].get("question") else "validate")
        builder.add_conditional_edges("clarify", lambda state:END if state.get("cancelled") else "understand")
        builder.add_conditional_edges("validate", lambda state:"review" if state["plan"].get("is_deck") or sum(card["quantity"] for card in state["plan"]["cards"]) == 60 else "quote")
        builder.add_conditional_edges("review", lambda state:END if state.get("cancelled") else "understand" if state.get("deck_approval",{}).get("action")=="revise_deck" else "quote")
        builder.add_edge("quote", "missing")
        builder.add_conditional_edges("missing", lambda state:"decide" if state["budget"]["missing"] else "finish")
        builder.add_conditional_edges("decide", lambda state:END if state.get("cancelled") else "understand" if state.get("consent",{}).get("action")=="substitute" else "finish")
        builder.add_edge("finish", END)
        self.graph = builder.compile(checkpointer=DatabaseSaver(repo))

    async def understand(self, state):
        progress("legality","Retrieving current dated format and banned-card evidence.")
        trace,public=tool_start("current_legality",{})
        try:
            knowledge = await self.planner.research.legality_knowledge()
            tool_end(trace,"current_legality",public,"complete",knowledge.get("official_sources",[]))
        except Exception:
            tool_end(trace,"current_legality",public,"error")
            raise
        if state.get("images"):
            progress("context",f"Using {len(state['images'])} image attachments as context; card identities still require source verification.")
        progress("understand","Resolving the request with sourced card and deck research.")

        # Pre-seed research sources from any previous plan sources
        if state.get("plan", {}).get("sources"):
            for s in state["plan"]["sources"]:
                url_val = s.get("url") if isinstance(s, dict) else getattr(s, "url", None)
                if url_val:
                    try:
                        self.planner.research.sources[str(url_val)] = (
                            Source.model_validate(s) if isinstance(s, dict) else s
                        )
                    except Exception:
                        pass

        kwargs = {}
        if state.get("images"):
            kwargs["images"] = state["images"]
        if state.get("preferences"):
            kwargs["preferences"] = state["preferences"]
        try:
            plan = await self.planner.resolve(state["request"], state.get("history", []), knowledge, **kwargs)
        except TypeError:
            plan = await self.planner.resolve(state["request"], state.get("history", []), knowledge)
        return {"knowledge":knowledge, "plan":plan.model_dump(mode="json"), "consent":{}, "deck_approval":{},
                "event":{"type":"progress", "data":{"step":"understand", "message":plan.question or "Resolved actual card/deck identities and preferences."}}}

    async def clarify(self, state):
        interrupt_payload = {
            "kind": "clarification",
            "question": state["plan"]["question"],
            "options": state["plan"].get("options", []),
            "actions": ["clarify", "cancel"],
        }
        decision = Decision.model_validate(interrupt(interrupt_payload))
        if decision.action == "cancel":
            return {"cancelled": True}
        text = decision.text.strip()
        if decision.selected_option and not text:
            text = decision.selected_option
        elif decision.selected_option and text:
            text = f"{decision.selected_option} ({text})"
        if decision.action != "clarify" or not text:
            raise ValueError("A clarification answer is required.")

        history = list(state.get("history") or [])
        history.append({
            "role": "assistant",
            "content": {"type": "question", "data": interrupt_payload},
        })
        history.append({
            "role": "user",
            "content": {"text": text},
        })
        return {
            "request": state["request"] + "\nUser clarification: " + text,
            "history": history,
        }

    async def validate(self, state):
        plan = AgentPlan.model_validate(state["plan"])
        legality = await self.planner.legality(plan, state["knowledge"])
        return {"legality":legality.model_dump(mode="json"),
                "event":{"type":"cards", "data":{"cards":state["plan"]["cards"], "sources":state["plan"]["sources"], "legality":legality.model_dump(mode="json")}}}

    async def quote(self, state):
        offers, errors = [], []
        cards = AgentPlan.model_validate(state["plan"]).cards
        sem = asyncio.Semaphore(8)
        lock = asyncio.Lock()

        async def _quote_one(card, supplier):
            async with sem:
                trace, public = tool_start("quote_supplier", {"supplier": supplier, "card_id": card.card_id})
                try:
                    progress("quote", f"Checking {supplier} quotations for {card.name}.")
                    found = await self.suppliers.quote(supplier, card)
                    async with lock:
                        offers.extend(found)
                    tool_end(trace, "quote_supplier", public, "complete", [offer.source for offer in found])
                except SupplierError as error:
                    tool_end(trace, "quote_supplier", public, "error")
                    message = {"supplier": supplier, "message": str(error)}
                    async with lock:
                        if message not in errors:
                            errors.append(message)

        tasks = [_quote_one(card, supplier) for card in cards for supplier in ("TCGplayer", "Cardmarket")]
        if tasks:
            await asyncio.gather(*tasks)

        return {"offers": [offer.model_dump(mode="json") for offer in offers], "supplier_errors": errors,
                "event": {"type": "progress", "data": {"step": "quote", "message": f"Retrieved {len(offers)} offers; {len(errors)} supplier limitations.", "limitations": errors}}}

    async def review(self, state):
        plan = state["plan"]
        payload = {
            "kind": "deck_approval",
            "question": "Review the deck, then approve it to compare supplier prices and prepare your buying budget. You can request changes before pricing starts.",
            "actions": ["approve_deck", "revise_deck", "cancel"],
            "card_count": sum(card["quantity"] for card in plan["cards"]),
            "unique_cards": len(plan["cards"]),
            "format": plan.get("format"), "ruleset": plan.get("ruleset"),
            "location": state.get("preferences", {}).get("location", ""),
            "target_currency": state.get("preferences", {}).get("target_currency"),
        }
        decision = Decision.model_validate(interrupt(payload))
        if decision.action == "cancel":
            return {"cancelled": True}
        if decision.action == "approve_deck" and decision.approved:
            return {"deck_approval": {"action": "approve_deck", "approved": True, "cards": plan["cards"]},
                    "event": {"type": "progress", "data": {"step": "deck_approved", "message": "Deck approved. Comparing supplier prices to prepare your budget."}}}
        if decision.action == "revise_deck" and decision.text.strip():
            history = [*state.get("history", []),
                       {"role": "assistant", "content": {"type": "cards", "data": {"cards": plan["cards"]}}},
                       {"role": "user", "content": {"text": decision.text.strip()}}]
            return {"request": state["request"] + "\nRequested deck changes before pricing: " + decision.text.strip(),
                    "history": history, "deck_approval": {"action": "revise_deck", "approved": False}}
        raise ValueError("Approve the displayed deck, request specific changes, or cancel before pricing.")

    async def missing(self, state):
        cards = AgentPlan.model_validate(state["plan"]).cards
        offers = [Offer.model_validate(row) for row in state["offers"]]
        result = budgets(cards, offers)
        result["reference_estimates"] = reference_estimates(cards, offers)
        if result["reference_estimates"]:
            result["recommendation"] = "Review the supplier budgets and price-guide estimates below. Price-guide estimates do not establish stock, condition, language, delivery, or a confirmed purchase total. Converted amounts are indicative; the original supplier amounts remain available."
        advice = await self.planner.alternatives(AgentPlan.model_validate(state["plan"]), result["missing"]) if result["missing"] else ""
        return {"budget":result, "question":{"kind":"missing_cards", "missing":result["missing"], "guidance":advice,
                                              "question":"Choose substitutes to research, or explicitly permit retaining these missing cards.", "actions":["substitute", "keep_missing", "cancel"]}}

    async def decide(self, state):
        decision = Decision.model_validate(interrupt(state["question"]))
        if decision.action == "cancel":
            return {"cancelled":True}
        if decision.action == "keep_missing" and decision.approved:
            return {"consent":{"action":"keep_missing", "missing":state["budget"]["missing"], "approved":True}}
        if decision.action == "substitute" and decision.approved and decision.text.strip():
            history = list(state.get("history") or [])
            history.append({
                "role": "assistant",
                "content": {
                    "type": "question",
                    "data": state["question"],
                    "missing": state["budget"]["missing"],
                    "guidance": state["question"].get("guidance", ""),
                    "plan": state.get("plan"),
                },
            })
            history.append({
                "role": "user",
                "content": {"text": decision.text},
            })
            return {
                "request": state["request"] + "\nUser explicitly requests researching these substitutes: " + decision.text,
                "consent": {"action": "substitute", "text": decision.text, "approved": True},
                "history": history,
            }
        raise ValueError("Explicit permission for the current missing cards or named substitutes is required.")

    async def finish(self, state):
        if state.get("consent", {}).get("action") == "keep_missing":
            event_writer()({
                "type": "thinking",
                "data": {
                    "id": uuid.uuid4().hex,
                    "status": "complete",
                    "source": "approach_summary",
                    "summary": "Applied user approval to retain missing cards and finalized supplier budgets.",
                },
            })
        result = {"plan":state["plan"], "legality":state["legality"],
                    "offers":state["offers"], **state["budget"], "supplier_errors":state["supplier_errors"],
                    "consent":state.get("consent",{}), "deck_approval":state.get("deck_approval",{}),
                    "preferences":state.get("preferences",{})}
        target = state.get("preferences", {}).get("target_currency")
        if target:
            trace, public = tool_start("convert_currency", {"target_currency": target})
            result = await self.exchange.convert(result, target)
            conversion = result.get("currency_conversion", {})
            tool_end(trace, "convert_currency", public,
                     "complete" if conversion.get("status") == "available" else "error",
                     [conversion["source"]] if conversion.get("source") else [])
        return {"event":{"type":"result", "data":result}}

    async def stream(self, execution_id: str, user_id: str, initial=None, decision: Decision | None = None):
        execution = self.repo.execution(execution_id, user_id)
        config = {"configurable":{"thread_id":execution.id}, "recursion_limit":60}
        value = Command(resume=decision.model_dump(mode="json")) if decision else initial
        async for mode, updates in self.graph.astream(value, config, stream_mode=["updates","custom"]):
            if mode == "custom":
                if updates.get("data", {}).get("status") != "loading":
                    self.repo.event(execution.id, user_id, updates["type"], updates["data"])
                yield updates
                continue
            if "__interrupt__" in updates:
                question = updates["__interrupt__"][0].value
                self.repo.checkpoint(execution.id, user_id, question, "waiting")
                yield {"type":"question", "data":question}
            for node, output in updates.items():
                if node != "__interrupt__" and isinstance(output, dict) and output.get("event"):
                    event = output["event"]
                    self.repo.event(execution.id, user_id, event["type"], event["data"])
                    yield event
        status = self.repo.execution(execution.id, user_id).status
        if status != "waiting":
            snapshot = await self.graph.aget_state(config)
            final_status = "cancelled" if snapshot.values.get("cancelled") else "complete"
            self.repo.checkpoint(execution.id, user_id, {"finished":True}, final_status)
        yield {"type":"done", "data":{"status":self.repo.execution(execution.id,user_id).status}}
