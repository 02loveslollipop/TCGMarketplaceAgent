from datetime import datetime, timezone
import pytest
from unittest.mock import MagicMock, patch

from shared.repository import Repository, NotFound
from shared.contracts import UserPreferencesPayload, ConversationRenamePayload
from services.orchestrator.research import Research
from services.orchestrator.planner import Planner
from services.orchestrator.legality_sync import sync_legality, fetch_japan_extra_bans, JAPAN_EXTRA_BANS_FALLBACK


def test_user_preferences_lifecycle(repo):
    user_id = "test-pref-user-1"
    
    # Default preferences should be auto/auto
    default_prefs = repo.user_preferences(user_id)
    assert default_prefs["ruleset"] == "auto"
    assert default_prefs["format"] == "auto"

    # Update preferences
    saved = repo.save_user_preferences(user_id, ruleset="japan", format="expanded")
    assert saved["ruleset"] == "japan"
    assert saved["format"] == "expanded"

    # Query back
    updated = repo.user_preferences(user_id)
    assert updated["ruleset"] == "japan"
    assert updated["format"] == "expanded"


def test_conversation_rename_and_delete(repo):
    user_id = "test-conv-user-1"
    
    # Create conversation and message
    conv = repo.new_conversation(user_id, "Original")
    repo.add_message(conv.id, user_id, "user", {"text": "Original message"})
    convs = repo.conversations(user_id)
    matching = [c for c in convs if c.id == conv.id]
    assert len(matching) == 1
    assert matching[0].title == "Original"

    # Rename conversation
    renamed = repo.rename_conversation(conv.id, user_id, "New Title")
    assert renamed is not None
    assert renamed.title == "New Title"

    # Delete conversation
    repo.delete_conversation(conv.id, user_id)
    # Deleting again raises NotFound
    with pytest.raises(NotFound):
        repo.delete_conversation(conv.id, user_id)


def test_legality_catalog_queries(repo):

    # Replace catalog with sample data
    sets = [
        {
            "id": "international:sv08",
            "ruleset": "international",
            "tcgdex_id": "sv08",
            "set_code": "SSP",
            "name": "Surging Sparks",
            "series": "Scarlet & Violet",
            "release_date": "2024-11-08",
            "legal_standard": True,
            "legal_expanded": True,
            "card_count": 252,
        },
        {
            "id": "japan:sv8",
            "ruleset": "japan",
            "tcgdex_id": "sv8",
            "set_code": "SV8",
            "name": "Super Electric Breaker",
            "series": "Scarlet & Violet",
            "release_date": "2024-10-18",
            "legal_standard": True,
            "legal_expanded": True,
            "card_count": 130,
        },
    ]
    bans = [
        {
            "id": "international:expanded:test-ban-1",
            "ruleset": "international",
            "format": "expanded",
            "card_id": "test-ban-1",
            "card_name": "Lysandre's Trump Card",
            "set_code": "PHF",
            "card_number": "99",
            "reason": "Official Play! Pokémon Expanded Banned List",
            "source_url": "https://www.pokemon.com",
        }
    ]
    sync_state = {
        "status": "synced",
        "last_refreshed_at": datetime.now(timezone.utc),
        "triggered_by": "test",
        "international_standard_marks": ["H", "I", "J"],
        "japan_standard_marks": ["H", "I", "J"],
        "sets_count": 2,
        "banned_count": 1,
        "sources": ["https://api.tcgdex.net/v2/graphql"],
    }

    repo.replace_legality_catalog(sets=sets, bans=bans, sync_state=sync_state)

    status = repo.legality_status()
    assert status["status"] == "synced"
    assert status["sets_count"] == 2
    assert status["banned_count"] == 1
    assert "H" in status["international_standard_marks"]

    # Query catalog
    res = repo.query_legality_catalog(ruleset="international", format="expanded", card_name="Lysandre's Trump Card")
    assert len(res["banned_cards"]) == 1
    assert res["banned_cards"][0]["card_name"] == "Lysandre's Trump Card"

    # Query set code resolution
    resolved = repo.resolve_set_code("SSP")
    assert resolved == "sv08"


@pytest.mark.asyncio
async def test_research_tcgdex_graphql(repo):
    research = Research(repo)

    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "data": {
            "card": {
                "id": "sv08-001",
                "localId": "1",
                "name": "Exeggcute",
                "set": {"id": "sv08", "name": "Surging Sparks"},
            }
        }
    }
    mock_resp.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", return_value=mock_resp):
        data = await research.query_tcgdex_graphql(
            query="query GetCard($id: String!) { card(id: $id) { id name } }",
            variables={"id": "sv08-001"},
        )
        assert data.get("data", {}).get("card", {}).get("name") == "Exeggcute"


def test_japan_extra_bans_parser():
    mock_html = """
    次のカードは、デッキに入れることができません。
    <ul>
      <li>シェイミEX（XY-P）</li>
      <li>マーシャドー（SM3N 045/070）</li>
    </ul>
    過去のシリーズで使用できるカード
    """
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.text = mock_html

    with patch("httpx.Client.get", return_value=mock_resp):
        bans = fetch_japan_extra_bans()
        assert len(bans) >= 2
        assert any("シェイミEX" in b["card_name_ja"] for b in bans)
        assert any("マーシャドー" in b["card_name_ja"] for b in bans)

    # Fallback verification
    assert len(JAPAN_EXTRA_BANS_FALLBACK) > 10


@pytest.mark.asyncio
async def test_query_tcgdex_graphql_filter_and_caching(repo):
    research = Research(repo)
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "data": {
            "cards": [
                {
                    "id": "me01-077",
                    "localId": "077",
                    "name": "Mega Lucario ex",
                    "category": "Pokemon",
                    "set": {"id": "me01", "name": "Mega Evolution", "tcgOnline": "MEG"},
                    "legal": {"standard": True, "expanded": True},
                },
                {
                    "id": "xy3-055",
                    "localId": "55",
                    "name": "M Lucario-EX",
                    "category": "Pokemon",
                    "set": {"id": "xy3", "name": "Furious Fists", "tcgOnline": "FFI"},
                    "legal": {"standard": False, "expanded": True},
                },
            ]
        }
    }
    mock_resp.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", return_value=mock_resp):
        # Query without raw query string, using structured filter name and set_id
        res = await research.query_tcgdex_graphql(name="Lucario", set_id="me01")

        # Caching check: both cards were inspected and cached in research.cards
        assert "me01-077" in research.cards
        assert research.cards["me01-077"]["name"] == "Mega Lucario ex"
        assert "xy3-055" in research.cards

        # Client-side filtering check: only cards matching set_id='me01' returned in data["cards"]
        returned_cards = res["data"]["cards"]
        assert len(returned_cards) == 1
        assert returned_cards[0]["id"] == "me01-077"


def test_admin_execution_detail_reasoning_and_audit_logs(repo):
    user_id = "test-admin-user"
    conv = repo.new_conversation(user_id, "Test Conversation")
    exec_row = repo.new_execution(conv.id, user_id, "openai/gpt-6-luna")

    # Add thinking event, reasoning event, and audit log
    repo.event(exec_row.id, user_id, "thinking", {"status": "complete", "source": "approach_summary", "summary": "Approach plan explanation."})
    repo.event(exec_row.id, user_id, "reasoning", {"status": "complete", "source": "provider_summary", "summary": "Internal provider thoughts."})
    repo.event(exec_row.id, user_id, "tool", {"name": "query_tcgdex_graphql", "input": {"name": "Lucario"}})

    detail = repo.admin_execution_detail(exec_row.id)
    assert detail["id"] == exec_row.id
    assert "Provider Reasoning" in detail["reasoning_summary"]
    assert "Approach Summary" in detail["reasoning_summary"]
    assert len(detail["events"]) == 3
    assert len(detail["logs"]) >= 3
    assert any(log["action"] == "thinking" for log in detail["logs"])


@pytest.mark.asyncio
async def test_planner_cross_ruleset_conflict_and_set_legality(repo):
    from shared.contracts import AgentPlan, CardRequest
    research = Research(repo)
    planner = Planner(None, research)

    # Seed catalog with sets and bans where card is banned in International but legal in Japan
    sets = [
        {
            "id": "international:xy4",
            "ruleset": "international",
            "tcgdex_id": "xy4",
            "set_code": "PHF",
            "name": "Phantom Forces",
            "series": "XY",
            "release_date": "2014-11-05",
            "legal_standard": False,
            "legal_expanded": True,
            "card_count": 120,
        },
        {
            "id": "japan:xy4",
            "ruleset": "japan",
            "tcgdex_id": "xy4",
            "set_code": "XY4",
            "name": "Phantom Gate",
            "series": "XY",
            "release_date": "2014-09-13",
            "legal_standard": False,
            "legal_expanded": True,
            "card_count": 90,
        },
    ]
    bans = [
        {
            "id": "intl-ban-trump",
            "ruleset": "international",
            "format": "expanded",
            "card_id": "xy4-99",
            "card_name": "Lysandre's Trump Card",
            "set_code": "PHF",
            "card_number": "99",
            "reason": "Official Play! Pokemon Expanded Ban",
            "source_url": "https://www.pokemon.com",
        }
    ]
    repo.replace_legality_catalog(sets=sets, bans=bans, sync_state={"status": "synced", "international_standard_marks": ["H", "I", "J"], "japan_standard_marks": ["H", "I", "J"]})

    # Cache card in research
    research.cards["xy4-99"] = {
        "id": "xy4-99",
        "localId": "99",
        "name": "Lysandre's Trump Card",
        "set": {"id": "xy4", "name": "Phantom Forces", "tcgOnline": "PHF"},
        "category": "Trainer",
        "trainerType": "Supporter",
        "legal": {"standard": False, "expanded": True},
    }

    plan = AgentPlan(
        format="expanded",
        cards=[
            CardRequest(
                card_id="xy4-99",
                name="Lysandre's Trump Card",
                quantity=1,
                set_name="Phantom Forces",
                number="99",
                condition="Near Mint",
                language="English",
                printing="Normal",
            )
        ],
    )

    # Validate with ruleset='auto' -> should detect conflict and return question with options
    validated = planner.validate(plan, preferences={"ruleset": "auto", "format": "expanded"})
    assert validated.question is not None
    assert "banned in International" in validated.question
    assert "International (Play! Pokémon)" in validated.options
    assert "Japan (Official Pokémon Card)" in validated.options

    # Validate legality of pre-BW set (e.g. Base Set) in Expanded
    research.cards["base1-4"] = {
        "id": "base1-4",
        "localId": "4",
        "name": "Charizard",
        "set": {"id": "base1", "name": "Base Set", "tcgOnline": "BS"},
        "category": "Pokemon",
        "legal": {"standard": False, "expanded": False},
    }
    old_card_plan = AgentPlan(
        format="expanded",
        ruleset="international",
        cards=[
            CardRequest(
                card_id="base1-4",
                name="Charizard",
                quantity=1,
                set_name="Base Set",
                number="4",
                condition="Near Mint",
                language="English",
                printing="Normal",
            )
        ],
    )
    legality_res = await planner.legality(old_card_plan, knowledge={})
    assert any("which is not legal in International Expanded format" in issue for issue in legality_res.issues)


@pytest.mark.asyncio
async def test_weekly_auto_refresh_trigger(repo):
    research = Research(repo)
    # With uninitialized status, legality_knowledge triggers should_refresh_legality
    with patch("services.orchestrator.research.sync_legality", return_value={}) as mock_sync:
        await research.legality_knowledge()
        assert mock_sync.called


def test_ddg_mcp_service_health_and_auth(monkeypatch):
    from starlette.testclient import TestClient
    import services.ddg_mcp.main as ddg_main

    with TestClient(ddg_main.app) as client:
        # GET /health returns 200 OK
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

        # When MCP_AUTH_TOKEN is set, /mcp requires Bearer token
        monkeypatch.setenv("MCP_AUTH_TOKEN", "test-secret-token")
        mcp_unauth = client.post("/mcp")
        assert mcp_unauth.status_code == 401
        assert mcp_unauth.json() == {"error": "Unauthorized"}

        health_auth = client.get("/health")
        assert health_auth.status_code == 200


@pytest.mark.asyncio
async def test_research_search_ddg_mcp():
    research = Research()
    mock_mcp_output = """Found 2 search results:

1. Limitless TCG Decks
   URL: https://limitlesstcg.com/decks
   Summary: Tournament Pokémon TCG deck lists and standings.

2. PokeBeach News
   URL: https://pokebeach.com/news
   Summary: Latest Pokémon TCG set announcements and spoilers.
"""
    with patch.object(research, "_call_ddg_mcp_tool", return_value=mock_mcp_output) as mock_call:
        results = await research.search("limitless decks")
        assert mock_call.called
        assert len(results) == 2
        assert results[0]["title"] == "Limitless TCG Decks"
        assert results[0]["url"] == "https://limitlesstcg.com/decks"
        assert "https://limitlesstcg.com/decks" in research.sources
        assert "https://pokebeach.com/news" in research.sources


@pytest.mark.asyncio
async def test_research_search_ddg_mcp_e2e_in_process():
    import services.ddg_mcp.main as ddg_main

    research = Research(mcp_url="")
    sample_html = '<div class="result"><h2 class="result__title"><a href="https://limitlesstcg.com/decks">Limitless Decks</a></h2><a class="result__snippet">Tournament lists</a></div>'

    async def mock_request(data, ctx):
        return sample_html

    with patch.object(ddg_main.ddg_server.searcher, "_request", side_effect=mock_request) as mock_req:
        results = await research.search("limitless decks")
        assert mock_req.called
        assert len(results) == 1
        assert results[0]["title"] == "Limitless Decks"
        assert results[0]["url"] == "https://limitlesstcg.com/decks"
        assert results[0]["excerpt"] == "Tournament lists"
        assert "https://limitlesstcg.com/decks" in research.sources


@pytest.mark.asyncio
async def test_research_fetch_ddg_mcp():
    research = Research()
    mock_content = """# Limitless TCG
Tournament deck lists and deck data for Pokémon TCG.

---
[Content info: Showing characters 0-80 of 80 total | parse=markdown]"""

    with patch.object(research, "_call_ddg_mcp_tool", return_value=mock_content) as mock_call:
        res = await research.fetch("https://limitlesstcg.com/decks")
        assert mock_call.called
        assert res["url"] == "https://limitlesstcg.com/decks"
        assert "[Content info:" not in res["excerpt"]
        assert "https://limitlesstcg.com/decks" in research.sources

    with patch.object(research, "_call_ddg_mcp_tool", return_value="Just a moment... Please verify you are human"):
        with pytest.raises(ValueError, match="verify you are human"):
            await research.fetch("https://limitlesstcg.com/blocked")


@pytest.mark.asyncio
async def test_research_get_deck_list_archetype_and_sets():
    research = Research()
    arch_html = """<html><body>
    <h1>Mega Lucario ex</h1>
    <a href="/decks/list/31206">1st Place List</a>
    </body></html>"""
    deck_html = """<html><body>
    <div class="decklist-card" data-set="POR" data-number="62">
        <span class="card-count">4</span>
        <span class="card-name">Lucario ex</span>
    </div>
    <div class="decklist-card" data-set="MEE" data-number="14">
        <span class="card-count">10</span>
        <span class="card-name">Fighting Energy</span>
    </div>
    </body></html>"""

    async def mock_get(url, *args, **kwargs):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        if "decks/345" in url:
            mock_resp.text = arch_html
        elif "decks/list/31206" in url:
            mock_resp.text = deck_html
        else:
            mock_resp.text = ""
        mock_resp.raise_for_status = MagicMock()
        return mock_resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        async def mock_get_cards(ids, **kwargs):
            return [
                {"id": "me03-62", "name": "Lucario ex", "localId": "62", "category": "Pokemon", "set": {"id": "me03", "name": "Perfect Order", "tcgOnline": "POR"}},
                {"id": "mee-014", "name": "Basic Fighting Energy", "localId": "14", "category": "Energy", "set": {"id": "mee", "name": "Mega Evolution Energy", "tcgOnline": "MEE"}},
            ]
        with patch.object(research, "get_cards", side_effect=mock_get_cards):
            res = await research.get_deck_list("345")
            assert res["source_url"] == "https://limitlesstcg.com/decks/list/31206"
            assert res["total_cards"] == 14
            cards = res["cards"]
            assert cards[0]["name"] == "Lucario ex"
            assert cards[0]["set_code"] == "POR"
            assert cards[1]["name"] == "Basic Fighting Energy"
            assert cards[1]["set_code"] == "MEE"
            assert not cards[0].get("unknown")
            assert not cards[1].get("unknown")


@pytest.mark.asyncio
async def test_planner_validate_energy_name_normalization_and_conflict(repo):
    research = Research(repo)
    planner = Planner(model=MagicMock(), research=research)

    research.cards["mee-014"] = {
        "id": "mee-014",
        "name": "Basic Fighting Energy",
        "localId": "14",
        "category": "Energy",
        "energyType": "Normal",
        "set": {"id": "mee", "name": "Mega Evolution Energy", "tcgOnline": "MEE"},
        "legal": {"standard": True, "expanded": True},
    }

    from shared.contracts import CardRequest, AgentPlan, utcnow
    plan = AgentPlan(
        format="standard",
        ruleset="international",
        cards=[
            CardRequest(
                card_id="mee-014",
                name="Fighting Energy",
                quantity=10,
                set_name="Mega Evolution Energy",
                number="14",
                condition="Near Mint",
                language="English",
                printing="Normal",
            )
        ],
    )

    validated = planner.validate(plan)
    assert validated.question is None
    assert validated.cards[0].name == "Basic Fighting Energy"
    assert validated.cards[0].basic_energy is True

    # Test auto ruleset resolves Japanese set without false-positive conflict when marks match
    sets = [
        {"id": "japan:m1", "ruleset": "japan", "tcgdex_id": "m1", "set_code": "M1", "name": "Mega Rayquaza ex", "series": "MEGA", "release_date": "2025-04-01", "legal_standard": True, "legal_expanded": True, "card_count": 120},
        {"id": "international:sv08", "ruleset": "international", "tcgdex_id": "sv08", "set_code": "SSP", "name": "Surging Sparks", "series": "Scarlet & Violet", "release_date": "2024-11-08", "legal_standard": True, "legal_expanded": True, "card_count": 252},
    ]
    repo.replace_legality_catalog(
        sets=sets,
        bans=[],
        sync_state={
            "status": "synced",
            "last_refreshed_at": utcnow(),
            "international_standard_marks": ["H", "I", "J"],
            "japan_standard_marks": ["H", "I", "J"],
        },
    )

    research.cards["m1-001"] = {
        "id": "m1-001",
        "name": "Mega Rayquaza ex",
        "localId": "001",
        "category": "Pokemon",
        "regulationMark": "I",
        "set": {"id": "m1", "name": "Mega Rayquaza ex", "tcgOnline": "M1"},
        "legal": {"standard": True, "expanded": True},
    }

    jp_plan = AgentPlan(
        format="standard",
        ruleset="international",
        cards=[
            CardRequest(
                card_id="m1-001",
                name="Mega Rayquaza ex",
                quantity=4,
                set_name="Mega Rayquaza ex",
                number="001",
                condition="Near Mint",
                language="Japanese",
                printing="Normal",
            )
        ],
    )
    validated_jp = planner.validate(jp_plan, preferences={"ruleset": "auto", "format": "standard"})
    assert validated_jp.question is None
    assert validated_jp.ruleset == "japan"

    # Test auto ruleset disambiguation on genuine regulation mark conflict across rulesets
    repo.replace_legality_catalog(
        sets=sets,
        bans=[],
        sync_state={
            "status": "synced",
            "last_refreshed_at": utcnow(),
            "international_standard_marks": ["H", "I"],
            "japan_standard_marks": ["H", "I", "J"],
        },
    )
    research.cards["m1-001"]["regulationMark"] = "J"
    conflict_plan = AgentPlan(
        format="standard",
        ruleset="international",
        cards=[
            CardRequest(
                card_id="m1-001",
                name="Mega Rayquaza ex",
                quantity=4,
                set_name="Mega Rayquaza ex",
                number="001",
                condition="Near Mint",
                language="Japanese",
                printing="Normal",
            )
        ],
    )
    validated_conflict = planner.validate(conflict_plan, preferences={"ruleset": "auto", "format": "standard"})
    assert validated_conflict.question is not None
    assert "differences between International and Japan rulesets" in validated_conflict.question
    assert "International (Play! Pokémon)" in validated_conflict.options
    assert "Japan (Official Pokémon Card)" in validated_conflict.options


@pytest.mark.asyncio
async def test_ensure_cards_loaded_and_missing_regulation_mark_in_standard(repo):
    from shared.contracts import AgentPlan, CardRequest

    research = Research(repo)
    planner = Planner(model=MagicMock(), research=research)

    sets = [
        {"id": "international:sv08", "ruleset": "international", "tcgdex_id": "sv08", "set_code": "SSP", "name": "Surging Sparks", "series": "Scarlet & Violet", "release_date": "2024-11-08", "legal_standard": True, "legal_expanded": True, "card_count": 252},
    ]
    repo.replace_legality_catalog(
        sets=sets,
        bans=[],
        sync_state={
            "status": "synced",
            "international_standard_marks": ["H", "I", "J"],
            "japan_standard_marks": ["H", "I", "J"],
        },
    )

    async def fake_get_cards(card_ids, language="en"):
        for cid in card_ids:
            if cid == "sv08-001":
                research.cards[cid] = {
                    "id": "sv08-001",
                    "name": "Exeggcute",
                    "localId": "1",
                    "category": "Pokemon",
                    "regulationMark": None,
                    "set": {"id": "sv08", "name": "Surging Sparks", "tcgOnline": "SSP"},
                }
        return [research.cards[cid] for cid in card_ids if cid in research.cards]

    with patch.object(research, "get_cards", side_effect=fake_get_cards) as mock_get_cards:
        plan = AgentPlan(
            format="standard",
            ruleset="international",
            cards=[
                CardRequest(
                    card_id="sv08-001",
                    name="Exeggcute",
                    quantity=4,
                    set_name="Surging Sparks",
                    number="1",
                    condition="Near Mint",
                    language="English",
                    printing="Normal",
                )
            ],
        )
        # research.cards starts empty (simulating resumed execution on a fresh Research instance)
        assert "sv08-001" not in research.cards
        leg = await planner.legality(plan, knowledge={})
        assert mock_get_cards.called
        assert "sv08-001" in research.cards
        assert any("Exeggcute (sv08-001) has no regulation mark and is not legal in Standard format" in i for i in leg.issues)


@pytest.mark.asyncio
async def test_ddg_mcp_http_401_raises_runtime_error_without_fallback():
    import httpx
    research = Research(mcp_url="http://ddg-mcp:8000/mcp", mcp_auth_token="bad-token")

    req = httpx.Request("POST", "http://ddg-mcp:8000/mcp")
    resp = httpx.Response(401, request=req)
    status_err = httpx.HTTPStatusError("401 Unauthorized", request=req, response=resp)

    with patch("mcp.client.streamable_http.streamable_http_client", side_effect=ExceptionGroup("mcp group", [status_err])):
        with pytest.raises(RuntimeError, match="ddg_mcp request failed with HTTP 401"):
            await research._call_ddg_mcp_tool("search", {"query": "test"})


@pytest.mark.asyncio
async def test_ddg_mcp_rejects_private_and_non_https_urls_and_redirects():
    import httpx
    import services.ddg_mcp.main as ddg_main

    for bad_url in ("http://example.com/page", "https://127.0.0.1/secret", "https://localhost/admin"):
        with pytest.raises(ValueError):
            await ddg_main.ddg_server.fetcher._guard_url(bad_url)
        res = await ddg_main.ddg_server.fetcher.fetch_and_parse(bad_url, None)
        assert res.startswith("Error: Refusing to fetch")

    # Verify HTTP redirect to private/loopback target is blocked by _guard_url on redirect hop
    redirect_resp = httpx.Response(
        302,
        headers={"location": "https://127.0.0.1/internal"},
        request=httpx.Request("GET", "https://limitlesstcg.com/redirect"),
    )
    with patch("httpx.AsyncClient.get", return_value=redirect_resp):
        with pytest.raises(ddg_main.PublicHttpsBlockedError):
            await ddg_main.ddg_server.fetcher._fetch_httpx("https://limitlesstcg.com/redirect")


@pytest.mark.asyncio
async def test_research_card_rest_fallback_without_recursion_and_ja_hydration():
    from shared.contracts import AgentPlan, CardRequest

    research = Research()
    gql_resp = MagicMock()
    gql_resp.json.return_value = {"data": {"c0": None}}
    gql_resp.raise_for_status = MagicMock()

    rest_resp = MagicMock()
    rest_resp.json.return_value = {
        "id": "sv8a-001",
        "localId": "001",
        "name": "リーフィア",
        "category": "Pokemon",
        "regulationMark": "H",
        "set": {"id": "sv8a", "name": "テラスタルフェスex", "tcgOnline": "SV8A"},
        "pricing": {"cardmarket": {}},
    }
    rest_resp.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", return_value=gql_resp) as mock_post, patch(
        "httpx.AsyncClient.get", return_value=rest_resp
    ) as mock_get:
        card_data = await research.card("sv8a-001", language="ja")
        assert card_data["id"] == "sv8a-001"
        assert "pricing" not in card_data
        # GraphQL called once, REST called once (no recursion)
        assert mock_post.call_count == 1
        assert mock_get.call_count == 1

    # Verify _ensure_cards_loaded passes language="ja" for Japanese cards
    research_ja = Research()
    planner = Planner(model=MagicMock(), research=research_ja)
    observed_langs = []

    async def capture_get_cards(ids, language="en"):
        observed_langs.append((ids, language))
        return []

    with patch.object(research_ja, "get_cards", side_effect=capture_get_cards):
        await planner._ensure_cards_loaded(
            AgentPlan(
                format="standard",
                cards=[
                    CardRequest(
                        card_id="sv8a-001",
                        name="リーフィア",
                        quantity=4,
                        set_name="テラスタルフェスex",
                        number="001",
                        condition="Near Mint",
                        language="Japanese",
                        printing="Normal",
                    )
                ],
            )
        )
    assert observed_langs == [(["sv8a-001"], "ja")]
