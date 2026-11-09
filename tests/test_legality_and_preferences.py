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

