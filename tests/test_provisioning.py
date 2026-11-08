from psycopg import sql
import pytest
from pydantic import ValidationError
from scripts.provision import schema_statements, SERVICE_TABLES
from shared.contracts import Offer
from shared.db import Base, SCHEMA


def test_only_dedicated_schema_and_explicit_service_grants():
    statements = schema_statements(dict.fromkeys(SERVICE_TABLES, "test-only-password"))
    rendered = [item.as_string() if isinstance(item, sql.Composable) else str(item) for item in statements if not isinstance(item, tuple)]
    assert all(table.schema == SCHEMA for table in Base.metadata.tables.values())
    assert all("public." not in value and "DROP " not in value for value in rendered)
    grants = [value for value in rendered if value.startswith("GRANT")]
    assert grants and all("ALL PRIVILEGES" not in value and "CREATE" not in value for value in grants)
    assert not any('users TO "pokemon_poc_orchestrator"' in value for value in grants)
    assert not any("DEFAULT PRIVILEGES" in value for value in rendered)


def test_offer_rejects_negative_price_and_unknown_fields():
    with pytest.raises(ValidationError):
        Offer(id="x", name="x", supplier="TCGplayer", price=-1, currency="USD", price_kind="listing", source={"url":"https://example.com", "title":"test"})
    with pytest.raises(ValidationError):
        Offer(id="x", name="x", supplier="TCGplayer", price=1, currency="USD", price_kind="listing", source={"url":"https://example.com", "title":"test"}, executable_markup="alert(1)")
