"""A real LangGraph workflow with durable, owner-bound human interruptions."""
import asyncio
import json
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command, interrupt

from shared.contracts import AgentPlan, Decision, Legality, Offer
from services.orchestrator.budget import budgets
from services.orchestrator.checkpoints import DatabaseSaver
from services.orchestrator.suppliers import SupplierError
from services.orchestrator.progress import progress


class State(TypedDict, total=False):
    request: str
    history: list
    knowledge: dict
    plan: dict
    legality: dict
    offers: list
    supplier_errors: list
    budget: dict
    question: dict
    consent: dict
    event: dict
    cancelled: bool


class DeckAgent:
    def __init__(self, repo, planner, suppliers):
        self.repo, self.planner, self.suppliers = repo, planner, suppliers
        builder = StateGraph(State)
        for name in ("understand", "clarify", "validate", "quote", "missing", "decide", "finish"):
            builder.add_node(name, getattr(self, name))
        builder.add_edge(START, "understand")
        builder.add_conditional_edges("understand", lambda state:"clarify" if state["plan"].get("question") else "validate")
        builder.add_conditional_edges("clarify", lambda state:END if state.get("cancelled") else "understand")
        builder.add_edge("validate", "quote")
        builder.add_edge("quote", "missing")
        builder.add_conditional_edges("missing", lambda state:"decide" if state["budget"]["missing"] else "finish")
        builder.add_conditional_edges("decide", lambda state:END if state.get("cancelled") else "understand" if state.get("consent",{}).get("action")=="substitute" else "finish")
        builder.add_edge("finish", END)
        self.graph = builder.compile(checkpointer=DatabaseSaver(repo))

    async def understand(self, state):
        progress("legality","Retrieving current dated format and banned-card evidence.")
        knowledge = await self.planner.research.legality_knowledge()
        progress("understand","Resolving the request with sourced card and deck research.")
        plan = await self.planner.resolve(state["request"], state.get("history",[]), knowledge)
        return {"knowledge":knowledge, "plan":plan.model_dump(mode="json"), "consent":{},
                "event":{"type":"progress", "data":{"step":"understand", "message":plan.question or "Resolved actual card/deck identities and preferences."}}}

    async def clarify(self, state):
        decision = Decision.model_validate(interrupt({"kind":"clarification", "question":state["plan"]["question"], "actions":["clarify", "cancel"]}))
        if decision.action == "cancel":
            return {"cancelled":True}
        if decision.action != "clarify" or not decision.text.strip():
            raise ValueError("A clarification answer is required.")
        return {"request":state["request"] + "\nUser clarification: " + decision.text}

    async def validate(self, state):
        plan = AgentPlan.model_validate(state["plan"])
        legality = await self.planner.legality(plan, state["knowledge"])
        return {"legality":legality.model_dump(mode="json"),
                "event":{"type":"cards", "data":{"cards":state["plan"]["cards"], "sources":state["plan"]["sources"], "legality":legality.model_dump(mode="json")}}}

    async def quote(self, state):
        offers, errors = [], []
        for card in AgentPlan.model_validate(state["plan"]).cards:
            for supplier in ("TCGplayer", "Cardmarket"):
                try:
                    progress("quote",f"Checking {supplier} quotations for {card.name}.")
                    offers.extend(await self.suppliers.quote(supplier, card))
                except SupplierError as error:
                    message = {"supplier":supplier, "message":str(error)}
                    if message not in errors:
                        errors.append(message)
        return {"offers":[offer.model_dump(mode="json") for offer in offers], "supplier_errors":errors,
                "event":{"type":"progress", "data":{"step":"quote", "message":f"Retrieved {len(offers)} offers; {len(errors)} supplier limitations.", "limitations":errors}}}

    async def missing(self, state):
        result = budgets(AgentPlan.model_validate(state["plan"]).cards, [Offer.model_validate(row) for row in state["offers"]])
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
            return {"request":state["request"] + "\nUser explicitly requests researching these substitutes: " + decision.text,
                    "consent":{"action":"substitute", "text":decision.text, "approved":True}}
        raise ValueError("Explicit permission for the current missing cards or named substitutes is required.")

    async def finish(self, state):
        return {"event":{"type":"result", "data":{"plan":state["plan"], "legality":state["legality"],
                    "offers":state["offers"], **state["budget"], "supplier_errors":state["supplier_errors"], "consent":state.get("consent",{})}}}

    async def stream(self, execution_id: str, user_id: str, initial=None, decision: Decision | None = None):
        execution = self.repo.execution(execution_id, user_id)
        config = {"configurable":{"thread_id":execution.id}, "recursion_limit":60}
        value = Command(resume=decision.model_dump(mode="json")) if decision else initial
        async for mode, updates in self.graph.astream(value, config, stream_mode=["updates","custom"]):
            if mode == "custom":
                self.repo.event(execution.id,user_id,updates["type"],updates["data"])
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
