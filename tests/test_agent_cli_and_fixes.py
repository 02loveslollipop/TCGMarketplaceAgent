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


def test_auth_and_chat_endpoint_helpers():
    from scripts.agent_cli import auth_endpoint, chat_endpoint

    # Local gateway
    assert auth_endpoint("http://localhost:8080", "", "/token") == "http://localhost:8080/api/auth/token"
    assert auth_endpoint("http://localhost:8080", "", "/api/auth/token") == "http://localhost:8080/api/auth/token"
    assert chat_endpoint("http://localhost:8080", "/executions") == "http://localhost:8080/api/chat/executions"
    assert chat_endpoint("http://localhost:8080", "/api/chat/executions") == "http://localhost:8080/api/chat/executions"

    # Split domain direct Heroku deployment
    assert (
        auth_endpoint("https://api.chat.tcgagent.herokuapp.com", "", "/token")
        == "https://api.auth.tcgagent.herokuapp.com/token"
    )
    assert (
        auth_endpoint("https://api.chat.tcgagent.herokuapp.com", "", "/api/auth/token")
        == "https://api.auth.tcgagent.herokuapp.com/token"
    )
    assert (
        chat_endpoint("https://api.chat.tcgagent.herokuapp.com", "/executions")
        == "https://api.chat.tcgagent.herokuapp.com/executions"
    )

    # Explicit auth_url
    assert (
        auth_endpoint("http://localhost:8000", "http://localhost:8001", "/token")
        == "http://localhost:8001/token"
    )


@pytest.mark.asyncio
async def test_resolve_auth_token_form_and_totp():
    import argparse
    from scripts.agent_cli import resolve_auth_token

    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        if request.url.path == "/api/auth/token":
            # Must receive form data
            assert request.headers["content-type"].startswith("application/x-www-form-urlencoded")
            body = request.read().decode("utf-8")
            assert "username=admin" in body
            assert "password=secret" in body
            return httpx.Response(200, json={"challenge_token": "chal-123"})
        if request.url.path == "/api/auth/totp/challenge":
            data = json.loads(request.read().decode("utf-8"))
            assert data["challenge_token"] == "chal-123"
            assert data["code"] == "123456"
            return httpx.Response(200, json={"access_token": "valid-jwt-token"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        args = argparse.Namespace(
            token="",
            token_file="",
            cookie="",
            username="admin",
            password="secret",
            totp_code="123456",
            totp_secret="",
            refresh=False,
            auth_url="",
        )
        token = await resolve_auth_token(client, "http://localhost:8080", args)
        assert token == "valid-jwt-token"
        assert len(calls) == 2


def test_normalize_printing_synonyms():
    assert normalize_printing("holo") == "holofoil"
    assert normalize_printing("non-holo") == "normal"
    assert normalize_printing("non holo") == "normal"
    assert normalize_printing("rev holo") == "reverse holofoil"
    assert normalize_printing("reverse holo") == "reverse holofoil"
    assert normalize_printing("standard") == "any"
    assert normalize_printing("not applicable") == "any"


@pytest.mark.asyncio
async def test_cardmarket_derived_holo_offer():
    suppliers = Suppliers()
    card = CardRequest(
        card_id="xy3-55",
        name="M Lucario EX",
        set_name="Furious Fists",
        number="55",
        condition="Near Mint",
        language="English",
        printing="holofoil",
        quantity=1,
    )
    # Cardmarket only returns low/trend (normal_low) because the card is naturally holo
    tcgdex_holo_sample = {
        "pricing": {
            "tcgplayer": {
                "unit": "USD",
                "holofoil": {"lowPrice": 12.0, "marketPrice": 15.0},
            },
            "cardmarket": {
                "unit": "EUR",
                "low": 8.50,
                "trend": 10.00,
                "avg": 9.50,
                "low-holo": 0.0,
                "trend-holo": 0.0,
            },
        }
    }
    suppliers._tcgdex_cache["en:xy3-55"] = tcgdex_holo_sample

    offers = await suppliers.quote("Cardmarket", card)
    assert len(offers) >= 1
    holo_offer = next((o for o in offers if o.printing == "Holofoil"), None)
    assert holo_offer is not None
    assert holo_offer.price == Decimal("8.50")
    assert equivalent(card, holo_offer) is True


@pytest.mark.asyncio
async def test_basic_energy_fallback_candidates():
    suppliers = Suppliers()
    # Fighting Energy mee-006 has no TCGplayer pricing
    suppliers._tcgdex_cache["en:mee-006"] = {
        "pricing": {
            "cardmarket": {"unit": "EUR", "low": 0.10},
        }
    }
    # But sve-006 has TCGplayer pricing
    suppliers._tcgdex_cache["en:sve-006"] = {
        "pricing": {
            "tcgplayer": {
                "unit": "USD",
                "normal": {"lowPrice": 0.15, "marketPrice": 0.25},
            }
        }
    }
    # Name lookup returns candidates
    suppliers._tcgdex_cache["name:en:fighting energy"] = [
        {"id": "mee-006", "name": "Fighting Energy", "localId": "006"},
        {"id": "sve-006", "name": "Basic Fighting Energy", "localId": "006"},
    ]

    card = CardRequest(
        card_id="mee-006",
        name="Fighting Energy",
        set_name="MEE",
        number="006",
        condition="Near Mint",
        language="English",
        printing="any",
        basic_energy=True,
        quantity=8,
    )

    tcg_offers = await suppliers.quote("TCGplayer", card)
    assert len(tcg_offers) > 0
    assert tcg_offers[0].supplier == "TCGplayer"
    assert tcg_offers[0].set_name == "MEE"
    assert tcg_offers[0].number == "006"
    assert equivalent(card, tcg_offers[0]) is True


def test_tokens_read_for_refresh_grace_period():
    from shared.db import User
    from services.auth.security import Tokens, AuthenticationError
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    pub_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    tokens = Tokens(public_key=pub_pem, private_key=priv_pem)
    user = User(id="u1", username="test", role="user", active=True, token_version=1)

    # Valid token
    tok = tokens.issue(user, "access")
    claims = tokens.read_for_refresh(tok)
    assert claims["sub"] == "u1"

    # Expired 2 hours ago (within 24h grace)
    import time, jwt
    now = int(time.time())
    expired_payload = {
        "sub": "u1", "iss": "pokemon-tcg-auth", "aud": "pokemon-tcg-poc",
        "iat": now - 7200, "nbf": now - 7200, "exp": now - 3600,
        "jti": "jti-1", "type": "access", "version": 1,
    }
    expired_tok = jwt.encode(expired_payload, priv_pem, algorithm="RS256")

    # read() rejects it
    with pytest.raises(AuthenticationError):
        tokens.read(expired_tok)

    # read_for_refresh() accepts it
    ref_claims = tokens.read_for_refresh(expired_tok, max_grace_seconds=86400)
    assert ref_claims["sub"] == "u1"

    # Expired 25 hours ago (beyond 24h grace)
    way_expired_payload = dict(expired_payload, exp=now - 90000)
    way_expired_tok = jwt.encode(way_expired_payload, priv_pem, algorithm="RS256")
    with pytest.raises(AuthenticationError, match="beyond refresh grace period"):
        tokens.read_for_refresh(way_expired_tok, max_grace_seconds=86400)


def test_context_preserves_approach_summary():
    from services.orchestrator.context import planning_content

    history = [
        {"role": "user", "content": {"text": "Hello"}},
        {"role": "assistant", "content": {"type": "thinking", "data": {"source": "provider_summary", "summary": "Thinking..."}}},
        {"role": "assistant", "content": {"type": "thinking", "data": {"source": "approach_summary", "summary": "Approach plan."}}},
        {"role": "assistant", "content": {"type": "tool", "data": {"name": "search"}}},
    ]
    content = planning_content("Build deck", history, [])
    text_data = json.loads(content[0]["text"])
    conv = text_data["conversation"]

    # provider_summary and tool should be filtered out, approach_summary should be kept!
    types = [c["content"].get("type") for c in conv if "type" in c["content"]]
    assert types == ["thinking"]
    assert conv[1]["content"]["data"]["source"] == "approach_summary"

