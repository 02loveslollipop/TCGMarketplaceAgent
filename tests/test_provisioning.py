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


def test_runtime_files_writes_session_limit_defaults(tmp_path, monkeypatch):
    from dotenv import dotenv_values
    from scripts.provision import runtime_files

    monkeypatch.chdir(tmp_path)
    passwords = dict.fromkeys(SERVICE_TABLES, "test-only-password")
    admin_info = {"host": "localhost", "port": "5432", "dbname": "testdb"}

    runtime_files(
        {"MAX_SESSION_HOURS": "24", "REFRESH_GRACE_SECONDS": "60"},
        passwords,
        admin_info,
    )
    auth_env = dotenv_values(tmp_path / ".runtime" / "auth.env")
    assert auth_env.get("MAX_SESSION_HOURS") == "24"
    assert auth_env.get("REFRESH_GRACE_SECONDS") == "60"

    runtime_files({}, passwords, admin_info)
    auth_env = dotenv_values(tmp_path / ".runtime" / "auth.env")
    assert auth_env.get("MAX_SESSION_HOURS") == "168"
    assert auth_env.get("REFRESH_GRACE_SECONDS") == "86400"


def test_offer_rejects_negative_price_and_unknown_fields():
    with pytest.raises(ValidationError):
        Offer(id="x", name="x", supplier="TCGplayer", price=-1, currency="USD", price_kind="listing", source={"url":"https://example.com", "title":"test"})
    with pytest.raises(ValidationError):
        Offer(id="x", name="x", supplier="TCGplayer", price=1, currency="USD", price_kind="listing", source={"url":"https://example.com", "title":"test"}, executable_markup="alert(1)")


def test_runtime_files_autogenerates_and_preserves_mcp_auth_token(tmp_path, monkeypatch):
    from dotenv import dotenv_values
    from scripts.provision import runtime_files

    monkeypatch.chdir(tmp_path)
    passwords = dict.fromkeys(SERVICE_TABLES, "test-only-password")
    runtime_files({}, passwords, {"host": "localhost", "port": "5432", "dbname": "testdb"})
    orch_env = dotenv_values(tmp_path / ".runtime" / "orchestrator.env")
    first_token = orch_env.get("MCP_AUTH_TOKEN")
    assert first_token and len(first_token) >= 32

    # Second run without MCP_AUTH_TOKEN in .env preserves the existing generated token
    runtime_files({}, passwords, {"host": "localhost", "port": "5432", "dbname": "testdb"})
    orch_env_second = dotenv_values(tmp_path / ".runtime" / "orchestrator.env")
    assert orch_env_second.get("MCP_AUTH_TOKEN") == first_token
