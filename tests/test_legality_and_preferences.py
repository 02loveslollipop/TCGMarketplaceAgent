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


