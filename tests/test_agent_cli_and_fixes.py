import json
import pytest
import httpx
from datetime import datetime, timezone
from decimal import Decimal
from shared.contracts import CardRequest, Offer, Source, utcnow, AgentPlan, Decision
from services.orchestrator.budget import normalize_condition, normalize_printing, equivalent, budgets
from services.orchestrator.planner import Planner
from services.orchestrator.suppliers import Suppliers, tcgplayer_listings_input
from scripts.agent_cli import match_clarification_choice, stream_sse


def test_card_request_normalization_matches_real_offers():
    # LLM produces "Not applicable" and "Standard"
    requested = CardRequest(
        card_id="sv06-112",
        name="Carmine",
        set_name="Twilight Masquerade",
        number="112",
        condition="Not applicable",
        language="English",
        printing="Standard",
        quantity=4,
    )
    assert normalize_condition(requested.condition) == "any"
    assert normalize_printing(requested.printing) == "any"

    real_offer = Offer(
        id="tcgplayer:123",
        name="Carmine",
        supplier="TCGplayer",
        set_name="Twilight Masquerade",
        number="112",
        condition="Near Mint",
        language="English",
        printing="Normal",
        price=Decimal("1.50"),
        currency="USD",
        quantity=4,
        availability="in_stock",
        price_kind="listing",
        shipping=None,
        shipping_confirmed=False,
        source=Source(url="https://www.tcgplayer.com/product/123", title="Carmine", retrieved_at=utcnow()),
    )
    assert equivalent(requested, real_offer) is True

    # Check budget engine produces complete coverage
    result = budgets([requested], [real_offer])
    combined = next(r for r in result["budgets"] if r["supplier"] == "combined")
    assert combined["complete"] is True
    assert len(result["missing"]) == 0


def test_tcgplayer_listings_input_has_search_keywords():
    card = CardRequest(
        card_id="sv06-112",
        name="Carmine",
        set_name="Twilight Masquerade",
        number="112",
        condition="Near Mint",
        language="English",
        printing="Normal",
        quantity=2,
    )
    payload = tcgplayer_listings_input(card, product_id=54321)
    assert payload["searchKeywords"] == ["Carmine Twilight Masquerade 112"]
    assert payload["startUrls"] == [{"url": "https://www.tcgplayer.com/product/54321"}]
    assert payload["proxyConfiguration"] == {"useApifyProxy": False}


@pytest.mark.asyncio
async def test_suppliers_quote_from_tcgdex():
    tcgdex_sample = {
        "pricing": {
            "tcgplayer": {
                "unit": "USD",
                "updated": "2026-11-10T03:13:51.370Z",
                "normal": {
                    "productId": 654415,
                    "lowPrice": 0.05,
                    "directLowPrice": 0.10,
                    "marketPrice": 0.20,
                    "midPrice": 0.25,
                },
                "reverse-holofoil": {
                    "productId": 654415,
                    "lowPrice": 0.15,
                    "marketPrice": 0.30,
                },
            },
            "cardmarket": {
                "unit": "EUR",
                "idProduct": 851147,
                "updated": "2026-11-10T03:13:24.417Z",
                "low": 0.02,
                "trend": 0.06,
                "avg": 0.05,
                "low-holo": 0.10,
                "trend-holo": 0.15,
            },
        }
    }

    suppliers = Suppliers()
    suppliers._tcgdex_cache["en:me01-076"] = tcgdex_sample

    card = CardRequest(
        card_id="me01-076",
        name="Test Card",
        set_name="Test Set",
        number="76",
        condition="Near Mint",
        language="English",
        printing="any",
        quantity=2,
    )

    tcg_offers = await suppliers.quote("TCGplayer", card)
    assert len(tcg_offers) >= 2
    assert all(o.supplier == "TCGplayer" for o in tcg_offers)
    assert all(o.currency == "USD" for o in tcg_offers)
    assert all(o.shipping_confirmed is False for o in tcg_offers)
    assert all("tcgplayer.com" in str(o.source.url) for o in tcg_offers)

    cm_offers = await suppliers.quote("Cardmarket", card)
    assert len(cm_offers) >= 2
    assert all(o.supplier == "Cardmarket" for o in cm_offers)
    assert all(o.currency == "EUR" for o in cm_offers)
    assert any(o.printing == "Normal" for o in cm_offers)
    assert any(o.printing == "Holofoil" for o in cm_offers)
    assert all("cardmarket.com" in str(o.source.url) for o in cm_offers)


def test_match_clarification_choice():
    options = ["Standard format (F, G, H blocks)", "Expanded format (Black & White onward)"]
    assert match_clarification_choice(options, "first") == options[0]
    assert match_clarification_choice(options, "0") == options[0]
    assert match_clarification_choice(options, "1") == options[1]
    assert match_clarification_choice(options, "standard") == options[0]
    assert match_clarification_choice(options, "expanded") == options[1]
    assert match_clarification_choice(options, "Custom choice") == "Custom choice"


@pytest.mark.asyncio
async def test_stream_sse_parser():
    raw_sse = (
        b"event: execution\ndata: {\"id\": \"exec-1\", \"conversation_id\": \"conv-1\"}\n\n"
        b"event: progress\ndata: {\"step\": \"understand\", \"message\": \"Thinking...\"}\n\n"
        b"event: done\ndata: {\"status\": \"complete\"}\n\n"
    )

    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=raw_sse, headers={"Content-Type": "text/event-stream"})
    )

    async with httpx.AsyncClient(transport=transport) as client:
        events = []
        async for ev, data in stream_sse(client, "http://test/stream", {}, {}):
            events.append((ev, data))

    assert len(events) == 3
    assert events[0] == ("execution", {"id": "exec-1", "conversation_id": "conv-1"})
    assert events[1] == ("progress", {"step": "understand", "message": "Thinking..."})
    assert events[2] == ("done", {"status": "complete"})
