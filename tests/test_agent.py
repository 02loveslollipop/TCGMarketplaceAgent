import pytest
from shared.contracts import AgentPlan, CardRequest, Decision, Legality, Offer, Source
from services.orchestrator.agent import DeckAgent
from services.orchestrator.planner import Planner
from services.orchestrator.research import Research
from ddgs.exceptions import DDGSException


class FakeResearch:
    async def legality_knowledge(self):
        return {"as_of":"2026-11-06", "official_sources":[{"url":"https://www.pokemon.com/rules", "title":"Synthetic rules fixture"}]}


class FakePlanner:
    research = FakeResearch()

    async def resolve(self, request, history, knowledge):
        if request == "Make M Gardevoir EX deck":
            return AgentPlan(question="Which printing and format?")
        return AgentPlan(format="standard", cards=[CardRequest(card_id="test-1", name="Test", quantity=1, set_name="Fixture", number="1", condition="NM", language="English", printing="Normal")], sources=[Source(url="https://example.com/deck",title="Synthetic deck")])

    async def legality(self, plan, knowledge):
        return Legality(status="verified", sources=[Source(url="https://www.pokemon.com/rules", title="Synthetic rules")])

    async def alternatives(self, plan, missing):
        return "A synthetic support card could serve the same role; confirm before research."


class FakeSuppliers:
    def __init__(self, stock=True):
        self.stock = stock

    async def quote(self, supplier, card):
        if supplier == "Cardmarket":
            return []
        return [Offer(id="listing", name=card.name, supplier="TCGplayer", set_name=card.set_name, number=card.number, condition=card.condition, language=card.language, printing=card.printing, quantity=1 if self.stock else 0, availability="in_stock" if self.stock else "out_of_stock", price="1.25", currency="USD", price_kind="listing", source=Source(url="https://example.com/listing",title="Synthetic listing"))]


def execution(repo):
    chat = repo.new_conversation("owner", "Deck")
    return repo.new_execution(chat.id, "owner", "fixture")


async def collect(agent, row, **kwargs):
    return [event async for event in agent.stream(row.id, "owner", **kwargs)]


async def test_clear_request_completes_with_sourced_prices_and_steps(repo):
    row = execution(repo)
    events = await collect(DeckAgent(repo, FakePlanner(), FakeSuppliers()), row, initial={"request":"Find exact Test Fixture 1 Standard English NM Normal", "history":[]})
    result = next(event["data"] for event in events if event["type"]=="result")
    assert result["plan"]["cards"][0]["quantity"] == 1
    assert result["offers"][0]["source"]["url"] == "https://example.com/listing"
    assert result["legality"]["status"] == "verified"
    assert events[-1]["data"]["status"] == "complete"
    assert repo.events(row.id,"owner")


async def test_ambiguous_request_persists_and_resumes_on_new_agent(repo):
    row = execution(repo)
    events = await collect(DeckAgent(repo, FakePlanner(), FakeSuppliers()), row, initial={"request":"Make M Gardevoir EX deck", "history":[]})
    assert next(event for event in events if event["type"]=="question")["data"]["kind"] == "clarification"
    assert repo.execution(row.id,"owner").status == "waiting"
    assert repo.claim_execution(row.id,"owner")
    events = await collect(DeckAgent(repo, FakePlanner(), FakeSuppliers()), row, decision=Decision(action="clarify",text="Fixture 1 standard English NM normal"))
    assert events[-1]["data"]["status"] == "complete"


async def test_missing_cards_require_scoped_explicit_consent(repo):
    row = execution(repo)
    events = await collect(DeckAgent(repo, FakePlanner(), FakeSuppliers(False)), row, initial={"request":"exact Test", "history":[]})
    question = next(event for event in events if event["type"]=="question")
    assert question["data"]["missing"][0]["card_id"] == "test-1"
    assert "support card" in question["data"]["guidance"]
    assert not any(event["type"]=="result" for event in events)
    assert repo.claim_execution(row.id,"owner")
    events = await collect(DeckAgent(repo, FakePlanner(), FakeSuppliers(False)), row, decision=Decision(action="keep_missing",approved=True))
    result = next(event["data"] for event in events if event["type"]=="result")
    assert result["consent"]["approved"] and result["consent"]["missing"] == result["stock_shortages"]


async def test_same_card_id_uncovered_variant_requires_specific_consent(repo):
    class VariantPlanner(FakePlanner):
        async def resolve(self, request, history, knowledge):
            original = CardRequest(card_id="test-1", name="Test", quantity=1, set_name="Fixture", number="1", condition="NM", language="English", printing="Normal")
            return AgentPlan(format="standard", cards=[original, original.model_copy(update={"condition":"LP"})])

    class NmOnlySuppliers(FakeSuppliers):
        async def quote(self, supplier, card):
            if supplier != "TCGplayer":
                return []
            if card.condition == "LP":
                return [Offer(id="lp-out", name=card.name, supplier=supplier, set_name=card.set_name, number=card.number, condition="LP", language=card.language, printing=card.printing, quantity=0, availability="out_of_stock", price="1.25", currency="USD", price_kind="listing", source=Source(url="https://example.com/lp",title="Synthetic out-of-stock listing"))]
            return [Offer(id="listing", name=card.name, supplier=supplier, set_name=card.set_name, number=card.number, condition="NM", language=card.language, printing=card.printing, quantity=1, availability="in_stock", price="1.25", currency="USD", price_kind="listing", source=Source(url="https://example.com/listing",title="Synthetic listing"))]

    row = execution(repo)
    agent = DeckAgent(repo, VariantPlanner(), NmOnlySuppliers())
    events = await collect(agent, row, initial={"request":"one NM and one LP", "history":[]})
    question = next(event["data"] for event in events if event["type"] == "question")
    assert question["kind"] == "missing_cards"
    assert question["missing"][0]["condition"] == "LP" and question["missing"][0]["quantity"] == 1
    assert question["missing"][0]["set_name"] == "Fixture"
    assert not any(event["type"] == "result" for event in events)
    assert repo.claim_execution(row.id,"owner")
    events = await collect(agent, row, decision=Decision(action="keep_missing", approved=True))
    result = next(event["data"] for event in events if event["type"] == "result")
    assert result["consent"]["missing"] == question["missing"] == result["stock_shortages"]


async def test_unapproved_missing_is_rejected_and_owner_enforced(repo):
    row = execution(repo)
    agent = DeckAgent(repo, FakePlanner(), FakeSuppliers(False))
    await collect(agent,row,initial={"request":"exact", "history":[]})
    with pytest.raises(ValueError, match="Explicit permission"):
        await collect(agent,row,decision=Decision(action="keep_missing",approved=False))
    with pytest.raises(Exception, match="Execution not found"):
        _ = [event async for event in agent.stream(row.id,"other",decision=Decision(action="keep_missing",approved=True))]


async def test_full_deck_over_twenty_distinct_ids_supports_batch_metadata(monkeypatch):
    research = Research()
    cards = [CardRequest(card_id=f"fixture-{number}",name=f"Fixture card {number}",quantity=2,set_name="Fixture set",number=str(number),condition="NM",language="English",printing="Normal") for number in range(21)]
    cards.append(CardRequest(card_id="fixture-energy",name="Basic Energy",quantity=18,set_name="Fixture set",number="energy",condition="NM",language="English",printing="Normal"))
    by_id = {card.card_id:card for card in cards}
    async def metadata(card_id):
        card = by_id[card_id]
        value = {"id":card_id,"name":card.name,"localId":card.number,"set":{"name":card.set_name},"category":"Energy" if card_id.endswith("energy") else "Pokemon","energyType":"Normal" if card_id.endswith("energy") else None,"image":"https://example.com/image"}
        research.cards[card_id]=value
        return value
    monkeypatch.setattr(research,"card",metadata)
    batch = next(tool for tool in research.tools() if tool.name=="get_cards")
    values = await batch.ainvoke({"card_ids":list(by_id)})
    assert len(values)==22
    planner=Planner(None,research)
    resolved=planner.validate(AgentPlan(is_deck=True,format="standard",cards=cards))
    assert not resolved.question and sum(card.quantity for card in resolved.cards)==60
    assert resolved.cards[-1].basic_energy
    with pytest.raises(ValueError,match="1 to 60"):
        await batch.ainvoke({"card_ids":["x"]*61})


def test_unverified_card_identity_and_incomplete_deck_are_clarified():
    planner=Planner(None,Research())
    plan=AgentPlan(format="standard",cards=[CardRequest(card_id="invented",name="Invented",quantity=1,set_name="Invented",number="1",condition="NM",language="English",printing="Normal")])
    assert planner.validate(plan).question
    assert "60-card" in planner.validate(plan.model_copy(update={"is_deck":True})).question


async def test_current_legality_no_results_is_explicitly_unverified(monkeypatch):
    research=Research()
    async def unavailable(query):
        raise DDGSException("No results found.")
    monkeypatch.setattr(research,"search",unavailable)
    knowledge=await research.legality_knowledge()
    assert knowledge["official_sources"]==[] and knowledge["as_of"]
    assert "unverified" in knowledge["warning"]
    result=await Planner(None,research).legality(AgentPlan(format="standard"),knowledge)
    assert result.status=="unverified"
