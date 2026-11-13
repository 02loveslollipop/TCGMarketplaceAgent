import asyncio
import json
from typing import TypedDict
import uuid
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command, interrupt

from shared.contracts import AgentPlan, Decision, Legality, Offer, Source
from services.orchestrator.budget import budgets, reference_estimates, availability_evidence
from services.orchestrator.checkpoints import DatabaseSaver
from services.orchestrator.suppliers import SupplierError, SupplierQuery
from services.orchestrator.progress import progress
from services.orchestrator.trace import tool_start, tool_end, event_writer
from services.orchestrator.exchange import exchange_rates, ExchangeUnavailable
from services.orchestrator.collection import select_collection


class State(TypedDict, total=False):
    request: str
    images: list
    history: list
    preferences: dict
    knowledge: dict
    plan: dict
    legality: dict
    offers: list
    route: str
    baseline_offers: list
    retrieval_diagnostics: list
    supplier_errors: list
    budget: dict
    question: dict
    consent: dict
    deck_approval: dict
    event: dict
    cancelled: bool
    collection_summary: dict


class DeckAgent:
    def __init__(self, repo, planner, suppliers, exchange=None):
        self.repo, self.planner, self.suppliers = repo, planner, suppliers
        self.exchange = exchange or exchange_rates
        builder = StateGraph(State)
        for name in ("router", "deck_builder", "collection_builder", "understand", "clarify", "validate", "review", "card_search", "collection_budget", "quote", "missing", "decide", "finish"):
            builder.add_node(name, getattr(self, name))
        builder.add_edge(START, "router")
        builder.add_conditional_edges("router", lambda state: "deck_builder" if state["route"] == "deck" else "collection_builder" if state['route']=='collection' else "understand")
        builder.add_conditional_edges("deck_builder", lambda state: "clarify" if state["plan"].get("question") else "validate")
        builder.add_conditional_edges("understand", lambda state:"clarify" if state["plan"].get("question") else "validate")
        builder.add_conditional_edges("collection_builder", lambda state:'clarify' if state['plan'].get('question') else 'validate')
        builder.add_conditional_edges("clarify", lambda state:END if state.get("cancelled") else "router")
        builder.add_conditional_edges("validate", lambda state:"review" if state['plan'].get('purpose')!='collection' and (state["plan"].get("is_deck") or sum(card["quantity"] for card in state["plan"]["cards"]) == 60) else "card_search")
        builder.add_conditional_edges("review", lambda state:END if state.get("cancelled") else "router" if state.get("deck_approval",{}).get("action")=="revise_deck" else "card_search")
        builder.add_conditional_edges('card_search',lambda state:'collection_budget' if state['plan'].get('purpose')=='collection' else 'quote')
        builder.add_edge('collection_budget','quote')
        builder.add_edge("quote", "missing")
        builder.add_conditional_edges("missing", lambda state:"decide" if state["budget"].get("stock_shortages", []) else "finish")
        builder.add_conditional_edges("decide", lambda state:END if state.get("cancelled") else "router" if state.get("consent",{}).get("action")=="substitute" else "finish")
        builder.add_edge("finish", END)
        self.graph = builder.compile(checkpointer=DatabaseSaver(repo))

    async def router(self, state):
        progress("route", "Determining whether to build a deck or research specified cards.")
        route = await self.planner.route(state["request"], state.get("history", []), state.get("images", [])) if hasattr(self.planner, "route") else "cards"
        return {"route": route}

    async def deck_builder(self, state):
        progress("deck_builder", "Building a sourced deck before card prices or stock affect the selection.")
        return await self.understand(state)

    async def collection_builder(self,state):
        progress('collection_builder','Researching collectible printings and art preferences before selecting an affordable collection.')
        return await self.understand(state)

    async def understand(self, state):
        progress("legality","Retrieving current dated format and banned-card evidence.")
        trace,public=tool_start("current_legality",{})
        try:
            knowledge = ({'official_sources':[], 'scope':'Collection metadata only; tournament legality is not a collecting restriction.'}
                         if state.get('route')=='collection' else await self.planner.research.legality_knowledge())
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

        kwargs = {"task": state["route"]} if hasattr(self.planner, "route") else {}
        if state.get("images"):
            kwargs["images"] = state["images"]
        if state.get("preferences"):
            kwargs["preferences"] = state["preferences"]
        try:
            plan = await self.planner.resolve(state["request"], state.get("history", []), knowledge, **kwargs)
        except TypeError:
            plan = await self.planner.resolve(state["request"], state.get("history", []), knowledge)
        return {"knowledge":knowledge, "plan":plan.model_dump(mode="json"), "consent":{}, "deck_approval":{}, "collection_summary":{},
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
        legality = (Legality(status='unverified',applicable=False,sources=plan.sources)
                    if plan.purpose=='collection' else await self.planner.legality(plan, state["knowledge"]))
        return {"legality":legality.model_dump(mode="json"),
                "event":{"type":"cards", "data":{"cards":state["plan"]["cards"], "sources":state["plan"]["sources"], "legality":legality.model_dump(mode="json"),"purpose":plan.purpose}}}

    async def _retrieve(self, state, phase):
        offers, errors, diagnostics = [], [], []
        cards = AgentPlan.model_validate(state["plan"]).cards
        sem = asyncio.Semaphore(8)

        async def one(card, supplier):
            async with sem:
                name = "baseline_prices" if phase == "baseline" else "check_supplier_stock"
                trace, public = tool_start(name, {"supplier": supplier, "card_id": card.card_id})
                try:
                    if hasattr(self.suppliers, "baseline"):
                        query = await getattr(self.suppliers, "baseline" if phase == "baseline" else "listings")(supplier, card)
                    elif phase == "baseline":
                        query = SupplierQuery(outcome="disabled", message="This adapter does not provide a separate price guide.")
                    else:
                        found = await self.suppliers.quote(supplier, card)
                        query = SupplierQuery(found, "success" if found else "empty", "supplier", "Retrieved prices." if found else "No listings returned; availability is unverified.")
                except SupplierError as error:
                    query = SupplierQuery(outcome=error.outcome, layer=error.layer, message=str(error), http_status=error.http_status)
                diagnostic = query.diagnostic(supplier, card, phase)
                diagnostics.append(diagnostic)
                offers.extend(query.offers)
                if query.outcome not in {"success", "empty"}:
                    error = {"supplier": supplier, "message": query.message, "layer": query.layer, "outcome": query.outcome, "phase": phase}
                    if error not in errors:
                        errors.append(error)
                tool_end(trace, name, public, "complete" if query.outcome in {"success", "empty", "disabled"} else "error",
                         [offer.source for offer in query.offers], diagnostic=diagnostic)
        await asyncio.gather(*(one(card, supplier) for card in cards for supplier in ("TCGplayer", "Cardmarket")))
        return offers, errors, diagnostics

    async def card_search(self, state):
        progress("baseline", "Finding baseline card prices without making stock assumptions.")
        offers, errors, diagnostics = await self._retrieve(state, "baseline")
        estimates = reference_estimates(AgentPlan.model_validate(state["plan"]).cards, offers)
        summary = "; ".join(f"{row['supplier']}: {row['product_subtotal']} {row['currency']} ({row['priced_cards']}/{row['requested_cards']} cards)" for row in estimates)
        event_writer()({"type": "thinking", "data": {"id": uuid.uuid4().hex, "status": "complete", "source": "approach_summary",
            "summary": ("Baseline price estimates: " + summary if summary else "No baseline prices could be verified.") + " Stock, language, condition and shipping are not confirmed. Checking seller listings next."}})
        return {"baseline_offers": [offer.model_dump(mode="json") for offer in offers], "supplier_errors": errors,
                "retrieval_diagnostics": diagnostics,
                "event": {"type": "progress", "data": {"step": "baseline", "message": "Baseline pricing complete. Checking seller availability and product links."}}}

    async def collection_budget(self,state):
        progress('collection_budget','Selecting researched printings within the product budget using dated exchange rates.')
        plan=AgentPlan.model_validate(state['plan']);snapshot=None
        trace,public=tool_start('select_collection',{'candidate_count':len(plan.cards),'currency':plan.collection.currency,'budget':str(plan.collection.budget_amount)})
        try:
            snapshot=await self.exchange.snapshot()
        except ExchangeUnavailable:
            # Same-currency evidence can still be selected. Cross-currency
            # evidence without a verified rate is excluded, never guessed.
            pass
        selected,summary=select_collection(plan,[Offer.model_validate(x) for x in state.get('baseline_offers',[])],self.planner.research.cards,snapshot)
        tool_end(trace,'select_collection',public,'complete' if summary['status']=='selected' else 'error',
                 [line['source'] for line in summary['lines']],diagnostic={'layer':'collection','outcome':summary['status'],'message':f"Selected {len(selected.cards)} researched printings. Shipping and stock remain unverified."})
        # Keep original evidence in diagnostics; only selected card offers
        # belong to the resulting purchase proposal.
        selected_names={(c.name,c.set_name,c.number) for c in selected.cards}
        offers=[o for o in state.get('baseline_offers',[]) if (o['name'],o.get('set_name'),o.get('number')) in selected_names]
        return {'plan':selected.model_dump(mode='json'),'collection_summary':summary,'baseline_offers':offers,
                'event':{'type':'cards','data':{'cards':selected.model_dump(mode='json')['cards'],'sources':state['plan']['sources'],'legality':state['legality'],'purpose':'collection'}}}

    async def quote(self, state):
        progress("availability", "Checking seller stock and purchase links separately from baseline prices.")
        offers, errors, diagnostics = await self._retrieve(state, "availability")
        return {"offers": [*state.get("baseline_offers", []), *[offer.model_dump(mode="json") for offer in offers]],
                "supplier_errors": [*state.get("supplier_errors", []), *errors],
                "retrieval_diagnostics": [*state.get("retrieval_diagnostics", []), *diagnostics],
                "event": {"type": "progress", "data": {"step": "availability", "message": f"Seller checks complete: {len(offers)} listing results. Unverified availability is kept separate from confirmed stock shortages.", "limitations": errors}}}

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
        result.update(availability_evidence(cards, offers))
        shortages = result["stock_shortages"]
        if result["reference_estimates"]:
            result["recommendation"] = "Review the supplier budgets and price-guide estimates below. Price-guide estimates do not establish stock, condition, language, delivery, or a confirmed purchase total. Converted amounts are indicative; the original supplier amounts remain available."
        if state.get('collection_summary'):
            summary=state['collection_summary']
            result['recommendation']=(f"Selected {summary['selected_printings']} collectible printings from {summary['researched_candidates']} researched candidates within a {summary['budget_amount']} {summary['currency']} product budget. Shipping, taxes, condition and availability remain unverified."
                                      if summary['status']=='selected' else 'No affordable collection could be established from convertible, verified price references. Review the candidate and exchange-rate limitations before changing the budget.')
        advice = await self.planner.alternatives(AgentPlan.model_validate(state["plan"]), shortages) if shortages else ""
        return {"budget":result, "question":{"kind":"missing_cards", "missing":shortages, "guidance":advice,
                                              "question":"The verified listings do not cover these card quantities. Other availability may be unverified. Choose substitutes to research, retain these shortages in the budget, or cancel.", "actions":["substitute", "keep_missing", "cancel"]}}

    async def decide(self, state):
        decision = Decision.model_validate(interrupt(state["question"]))
        if decision.action == "cancel":
            return {"cancelled":True}
        # Re-evaluate a pre-upgrade interruption only after consuming its owner's
        # decision. Cancellation and explicit substitution requests still apply.
        refreshed = {}
        if "stock_shortages" not in state["budget"]:
            refreshed = await self.missing(state)
            state = {**state, **refreshed}
        if decision.action == "keep_missing" and decision.approved:
            return {**refreshed, "consent": {"action":"keep_missing", "missing":state["question"]["missing"], "approved":True}
                    if state["budget"].get("stock_shortages") else {}}
        if decision.action == "substitute" and decision.approved and decision.text.strip():
            history = list(state.get("history") or [])
            history.append({
                "role": "assistant",
                "content": {
                    "type": "question",
                    "data": state["question"],
                    "missing": state["question"]["missing"],
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
                    "preferences":state.get("preferences",{}), "retrieval_diagnostics":state.get("retrieval_diagnostics",[])}
        if state.get('collection_summary'):result['collection_summary']=state['collection_summary']
        target = state.get("preferences", {}).get("target_currency") or (state.get('plan',{}).get('collection') or {}).get('currency')
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
