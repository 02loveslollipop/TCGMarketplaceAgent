"""Regressions found during the November project review; no live services required."""
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from services.auth.app import create_app
from services.auth.security import AuthenticationError
from services.orchestrator.budget import budgets
from services.orchestrator.legality_sync import fetch_tcgdex_sets, sync_legality, should_refresh_legality
from services.orchestrator.legality_sync import fetch_banned_card_metadata
from services.orchestrator.planner import Planner
from services.orchestrator.research import Research
from services.orchestrator.suppliers import Suppliers
from shared.contracts import AgentPlan, CardRequest, Legality, Source, utcnow
from tests.test_security import security


def card():
    return CardRequest(card_id="sv08-001", name="Test card", quantity=12,
                       set_name="Surging Sparks", number="001", condition="NM",
                       language="English", printing="any")


def install_catalog(repo, **state):
    repo.replace_legality_catalog(
        sets=[{"id": "international:sv08", "ruleset": "international",
               "tcgdex_id": "sv08", "set_code": "SSP", "name": "Surging Sparks",
               "legal_standard": True, "legal_expanded": True}],
        bans=[{"id": "ban-1", "ruleset": "international", "format": "expanded",
               "card_id": "test-9", "card_name": "Banned card"}],
        sync_state={"status": "synced", "last_refreshed_at": utcnow(),
                    "next_refresh_at": utcnow() + timedelta(days=7),
                    "sources": ["https://example.com/dated-rules"],
                    "international_standard_marks": ["H"], **state},
    )


def test_price_guides_never_create_stock_or_confirmed_budget():
    request = card()
    pricing = {"tcgplayer": {"non-holofoil": {"lowPrice": 1, "marketPrice": 2}},
               "cardmarket": {"low": 1, "trend": 2}}
    adapter = Suppliers()
    for supplier in ("TCGplayer", "Cardmarket"):
        offers = adapter._offers_from_tcgdex_pricing(
            request.card_id, pricing, supplier, request,
            Source(url="https://api.tcgdex.net/v2/en/cards/sv08-001", title="Catalog"))
        assert offers
        assert all(o.price_kind == "reference" and o.quantity is None for o in offers)
        assert all(o.availability == "unknown" and o.condition is None and o.language is None for o in offers)
        assert all(o.printing == ("Normal" if supplier == "TCGplayer" else None) for o in offers)
        result = budgets([request], offers)
        assert result["missing"][0]["quantity"] == 12
        assert not any(b["complete"] or b["confirmed_total"] for b in result["budgets"])


@pytest.mark.parametrize("path,method", [("/portal-session", "get"), ("/refresh", "post")])
def test_explicit_token_cannot_restore_another_cookie_account(repo, security, path, method):
    admin = repo.add_user("cookie-admin", "unused", role="admin")
    user = repo.add_user("bearer-user", "unused")
    for account in (admin, user):
        repo.update_user(account.id, totp_secret="enrolled")
    client = TestClient(create_app(repo, security))
    admin_token = security.tokens.issue(admin)
    client.post("/portal-session", headers={"Authorization": f"Bearer {admin_token}"})
    user_token = security.tokens.issue(user)
    response = getattr(client, method)(path, headers={"Authorization": f"Bearer {user_token}"})
    assert response.status_code == 200
    assert response.json()["session"]["id"] == user.id
    # A revoked bearer must fail even with a valid administrator cookie.
    client.post("/portal-session", headers={"Authorization": f"Bearer {admin_token}"})
    repo.update_user(user.id, token_version=user.token_version + 1)
    assert getattr(client, method)(path, headers={"Authorization": f"Bearer {user_token}"}).status_code == 401


def test_access_expiry_is_capped_and_old_session_is_rejected(repo, security, monkeypatch):
    monkeypatch.setenv("MAX_SESSION_HOURS", "2")
    monkeypatch.setenv("ACCESS_TOKEN_TTL_MINUTES", "480")
    user = repo.add_user("cap-user", "unused")
    original = int((utcnow() - timedelta(hours=1, minutes=59)).timestamp())
    token = security.tokens.issue(user, orig_iat=original)
    claims = security.tokens.read(token)
    assert claims["exp"] == original + 7200
    old = {**claims, "orig_iat": int((utcnow() - timedelta(hours=3)).timestamp())}
    old_token = jwt.encode(old, security.tokens.private_key, algorithm="RS256")
    with pytest.raises(AuthenticationError, match="maximum allowed duration"):
        security.tokens.read(old_token)


@pytest.mark.parametrize("state,expected", [(None, "unverified"), ({"status": "failed"}, "unverified"),
                                            ({"last_refreshed_at": utcnow() - timedelta(days=8)}, "unverified"),
                                            ({"sources": []}, "unverified"), ({}, "verified")])
async def test_catalog_evidence_controls_verification(repo, state, expected):
    if state is not None:
        install_catalog(repo, **state)
    research = Research(repo)
    research.cards[card().card_id] = {"id": card().card_id, "name": "Test card",
                                     "localId": "001", "regulationMark": "H",
                                     "set": {"id": "sv08", "name": "Surging Sparks"}}
    model = MagicMock()
    model.with_structured_output.return_value.ainvoke = AsyncMock(
        return_value=Legality(status="verified", sources=[Source(url="https://example.com/rules", title="Dated rules")]))
    legality = await Planner(model, research).legality(
        AgentPlan(format="standard", ruleset="international", cards=[card()]), {})
    assert legality.status == expected
    if expected == "unverified":
        assert any("catalog" in issue for issue in legality.issues)


def test_refresh_failure_preserves_previous_catalog_and_date(repo):
    install_catalog(repo)
    before = repo.query_legality_catalog()
    with patch("services.orchestrator.legality_sync.build_legality_dataset", side_effect=ValueError("offline")):
        status = sync_legality(repo, "admin:test")
    after = repo.query_legality_catalog()
    assert status["status"] == "failed"
    assert status["last_refreshed_at"] == before["sync_state"]["last_refreshed_at"]
    assert status["sources"] == before["sync_state"]["sources"]
    assert after["sets"] == before["sets"]
    assert after["banned_cards"] == before["banned_cards"]
    assert not should_refresh_legality(repo)  # bounded retry after an outage


@pytest.mark.parametrize("payload", [{"errors": [{"message": "schema changed"}]},
                                      {"data": {"enSets": [{"id": "sv08"}], "jaSets": []}}])
def test_partial_graphql_catalog_is_rejected(payload):
    response = MagicMock()
    response.json.return_value = payload
    with patch("httpx.Client.post", return_value=response), pytest.raises(ValueError, match="complete"):
        fetch_tcgdex_sets()


def test_banned_card_lookup_canonicalizes_legacy_shining_legends_id():
    response = MagicMock(status_code=200)
    response.json.return_value = {"data": {"c0": {"id": "sm3.5-45", "name": "Marshadow"}}}
    with patch("httpx.Client.post", return_value=response) as post:
        metadata = fetch_banned_card_metadata(["sm35-45"])
    assert 'card(id: "sm3.5-45")' in post.call_args.kwargs["json"]["query"]
    assert metadata["sm35-45"]["id"] == "sm3.5-45"


async def test_catalog_evidence_does_not_invent_successfully_retrieved_sources(repo):
    research = Research(repo)
    with patch("services.orchestrator.research.sync_legality"):
        knowledge = await research.legality_knowledge()
    assert knowledge["official_sources"] == []


def test_graphql_card_cache_ignores_set_nodes_and_preserves_full_metadata():
    research = Research()
    research._extract_and_cache_cards({"id": "sv08-001", "name": "Test card", "localId": "001",
                                       "regulationMark": "H", "set": {"id": "sv08", "name": "Surging Sparks"}})
    research._extract_and_cache_cards({"id": "sv08-001", "name": "Test card", "localId": "001",
                                       "set": {"id": "sv08"}})
    assert set(research.cards) == {"sv08-001"}
    assert research.cards["sv08-001"]["regulationMark"] == "H"
    assert research.cards["sv08-001"]["set"]["name"] == "Surging Sparks"


def test_name_and_number_match_cannot_silently_change_sets():
    research = Research()
    research.cards["xy3-001"] = {"id": "xy3-001", "name": "Test card", "localId": "001",
                                 "set": {"id": "xy3", "name": "Furious Fists"}}
    plan = Planner(MagicMock(), research).validate(
        AgentPlan(format="expanded", ruleset="international", cards=[card()]))
    assert plan.question is not None
    assert not plan.cards


async def test_auto_ruleset_answer_does_not_repeat_the_same_question(repo):
    from langchain_core.messages import AIMessage
    install_catalog(repo)
    research = Research(repo)
    request = card()
    request.name = "Banned card"
    research.cards[request.card_id] = {"id": request.card_id, "name": request.name, "localId": "001",
                                       "set": {"id": "sv08", "name": request.set_name}}
    model = MagicMock()
    model.bind_tools.return_value.ainvoke = AsyncMock(return_value=AIMessage(content="Ready"))
    plan = AgentPlan(format="expanded", ruleset="international", cards=[request])
    model.with_structured_output.return_value.ainvoke = AsyncMock(return_value=plan)
    planner = Planner(model, research)
    question = planner.validate(plan, preferences={"ruleset": "auto", "format": "auto"})
    assert question.question and question.options
    history = [{"role": "assistant", "content": {"type": "question", "data": question.model_dump()}},
               {"role": "user", "content": {"text": "Japan (Official Pokémon Card)"}}]
    resolved = await planner.resolve("Use Japan", history, {}, preferences={"ruleset": "auto", "format": "auto"})
    assert resolved.question is None
    assert resolved.ruleset == "japan"
