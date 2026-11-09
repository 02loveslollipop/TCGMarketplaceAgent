"""One-shot schema provisioning. This is the only code that reads the admin URI."""
import os
from pathlib import Path
import secrets

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from dotenv import dotenv_values
import psycopg
from psycopg import sql
from sqlalchemy.schema import CreateTable, CreateIndex
from sqlalchemy.dialects.postgresql import dialect

from shared.db import Base, SCHEMA

SERVICE_TABLES = {
    "auth": {"users": "SELECT, INSERT, UPDATE", "challenges": "SELECT, INSERT, UPDATE",
             "webauthn_credentials": "SELECT, INSERT, UPDATE, DELETE", "webauthn_challenges": "SELECT, INSERT, UPDATE",
             "logs": "INSERT", "enrollment_states": "SELECT, INSERT, UPDATE", "recovery_codes": "SELECT, INSERT, UPDATE, DELETE"},
    "admin": {
        "models": "SELECT, INSERT, UPDATE", "role_policies": "SELECT, INSERT, UPDATE", "logs": "SELECT, INSERT",
        "card_sets": "SELECT", "banned_cards": "SELECT", "legality_sync_state": "SELECT, INSERT, UPDATE",
        "executions": "SELECT", "events": "SELECT", "conversations": "SELECT",
    },
    "orchestrator": {
        "role_policies": "SELECT", "daily_token_usage": "SELECT, INSERT, UPDATE",
        "models": "SELECT", "conversations": "SELECT, INSERT, UPDATE, DELETE",
        "messages": "SELECT, INSERT, DELETE", "executions": "SELECT, INSERT, UPDATE, DELETE",
        "events": "SELECT, INSERT, DELETE", "logs": "SELECT, INSERT", "graph_checkpoints": "SELECT, INSERT, UPDATE, DELETE",
        "card_sets": "SELECT, INSERT, UPDATE, DELETE", "banned_cards": "SELECT, INSERT, UPDATE, DELETE",
        "legality_sync_state": "SELECT, INSERT, UPDATE, DELETE", "user_preferences": "SELECT, INSERT, UPDATE, DELETE",
    },
}


def schema_statements(passwords: dict[str, str]) -> list:
    statements = [sql.SQL("CREATE SCHEMA IF NOT EXISTS {} ").format(sql.Identifier(SCHEMA))]
    for service, tables in SERVICE_TABLES.items():
        role = f"pokemon_poc_{service}"
        # Role existence is checked by exact name, never by enumerating DB schemas.
        statements.append(("role", role, passwords[service]))
        statements.append(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(SCHEMA), sql.Identifier(role)))
    for table in Base.metadata.sorted_tables:
        statements.append(str(CreateTable(table, if_not_exists=True).compile(dialect=dialect())))
        for index in table.indexes:
            statements.append(str(CreateIndex(index, if_not_exists=True).compile(dialect=dialect())))
    for service, tables in SERVICE_TABLES.items():
        for table, grants in tables.items():
            statements.append(sql.SQL("GRANT {} ON TABLE {}.{} TO {}").format(
                sql.SQL(grants), sql.Identifier(SCHEMA), sql.Identifier(table),
                sql.Identifier(f"pokemon_poc_{service}")))
    return statements


def private_write(path: Path, content: str | bytes):
    mode = "wb" if isinstance(content, bytes) else "w"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(path, 0o600)
    with os.fdopen(descriptor, mode) as handle:
        handle.write(content)


def runtime_files(values: dict, passwords: dict, admin_info: dict):
    folder = Path(".runtime")
    folder.mkdir(mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    signing_key = folder / "jwt-private.pem"
    if not signing_key.exists():
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        private_write(signing_key, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        private_write(folder / "jwt-public.pem", key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    encryption_path = folder / "totp.key"
    if not encryption_path.exists():
        private_write(encryption_path, Fernet.generate_key())
    for service in SERVICE_TABLES:
        info = {k: v for k, v in admin_info.items() if k in {"host", "hostaddr", "port", "dbname", "sslmode", "sslrootcert"}}
        info.update(user=f"pokemon_poc_{service}", password=passwords[service])
        dsn = psycopg.conninfo.make_conninfo(**info)
        # sqlalchemy accepts libpq DSNs through a separate setting, avoiding URL escaping.
        lines = [f"DATABASE_DSN={dsn}", f"SERVICE_NAME={service}"]
        if service == "auth":
            lines.extend(["JWT_PRIVATE_KEY_FILE=/run/secrets/jwt_private", "TOTP_KEY_FILE=/run/secrets/totp_key"])
            for name, default in (("WEBAUTHN_RP_ID","localhost"),("WEBAUTHN_ORIGIN","http://localhost:8080")):
                value=str(values.get(name) or default)
                if "\n" in value or "\r" in value:
                    raise ValueError(f"Invalid multiline value for {name}")
                lines.append(f"{name}={value}")
        if service == "orchestrator":
            for name in ("OPENAI_API_KEY", "MISTRAL_API_KEY", "APIFY_API_KEY", "APIFY_TOKEN"):
                value = str(values.get(name) or "")
                if "\n" in value or "\r" in value:
                    raise ValueError(f"Invalid multiline value for {name}")
                lines.append(f"{name}={value}")
        private_write(folder / f"{service}.env", "\n".join(lines) + "\n")


def main():
    values = dotenv_values(".env")
    uri = (values.get("EXTERNAL_JDBC_POSTGRES_URI_ADMIN") or "").removeprefix("jdbc:")
    if not uri:
        raise SystemExit("Root .env requires EXTERNAL_JDBC_POSTGRES_URI_ADMIN.")
    passwords, existing_passwords = {}, set()
    for service in SERVICE_TABLES:
        path = Path(f".runtime/{service}.env")
        saved = dotenv_values(path) if path.exists() else {}
        info = psycopg.conninfo.conninfo_to_dict(saved["DATABASE_DSN"]) if saved.get("DATABASE_DSN") else {}
        if info.get("user") == f"pokemon_poc_{service}" and info.get("password"):
            passwords[service] = info["password"]
            existing_passwords.add(service)
        else:
            passwords[service] = secrets.token_urlsafe(36)
    with psycopg.connect(uri, connect_timeout=10) as connection:
        # Only an exact lookup of this application's schema, no unrelated objects.
        owner = connection.execute("SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) FROM pg_namespace WHERE nspname = %s", (SCHEMA,)).fetchone()
        if owner and not owner[0]:
            raise SystemExit("Existing app schema is not owned by this provisioner; refusing to modify it.")
        for statement in schema_statements(passwords):
            if isinstance(statement, tuple):
                _, role, password = statement
                flags = connection.execute("SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname = %s", (role,)).fetchone()
                if flags:
                    if any(flags):
                        raise SystemExit(f"Existing application role {role} has broader privileges; refusing to reuse it.")
                    service = role.removeprefix("pokemon_poc_")
                    if service not in existing_passwords:
                        raise SystemExit(f"Existing application role {role} needs its private .runtime credential restored before reprovisioning.")
                else:
                    connection.execute(sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
            else:
                connection.execute(statement)
        for api_id, label, provider in (("gpt-6-luna","GPT 6 luna","openai"), ("gpt-6.1-terra","GPT 6.1 terra","openai"), ("mistral-medium-latest","Mistral Medium","mistral")):
            connection.execute(sql.SQL("INSERT INTO {}.models (id,label,provider,api_id,enabled) VALUES (%s,%s,%s,%s,false) ON CONFLICT (id) DO NOTHING").format(sql.Identifier(SCHEMA)),(api_id,label,provider,api_id))
        runtime_files(values, passwords, connection.info.get_parameters())
    print("Provisioned only pokemon_tcg_poc. Service secrets written privately to .runtime/. No administrator account created.")


if __name__ == "__main__":
    try:
        main()
    except (psycopg.Error, ValueError, OSError) as error:
        raise SystemExit(f"Provisioning failed ({type(error).__name__}); check the private database/environment settings. No credential values were printed.") from None
