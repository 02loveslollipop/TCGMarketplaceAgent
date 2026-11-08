"""Verify only dedicated-schema runtime access, with writes rolled back."""
from dotenv import dotenv_values
import psycopg
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from shared.db import Conversation, ModelPolicy, User


def main():
    for service in ("auth","admin","orchestrator"):
        settings = dotenv_values(f".runtime/{service}.env")
        engine = create_engine("postgresql+psycopg://", creator=lambda:psycopg.connect(settings["DATABASE_DSN"],connect_timeout=10), hide_parameters=True)
        with engine.connect() as connection:
            assert connection.execute(text("SELECT has_schema_privilege(current_user, 'pokemon_tcg_poc', 'CREATE')")).scalar() is False
            assert connection.execute(text("SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user")).scalar() is False
        with Session(engine) as session:
            model = User(username="transaction-only-verification",password_hash="not-a-password-hash") if service=="auth" else ModelPolicy(id="transaction-only-verification",label="Verification",provider="openai",api_id="fixture",enabled=False) if service=="admin" else Conversation(user_id="transaction-only-verification",title="Rollback persistence verification")
            session.add(model)
            session.flush()
            assert session.get(type(model),model.id) is not None
            session.rollback()
        engine.dispose()
        print(f"{service}: own-schema persistence and restricted role checks passed; verification rows rolled back.")


if __name__=="__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"Runtime database check failed ({type(error).__name__}); no credential values printed.") from None
