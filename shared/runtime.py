"""Service-specific environment only; root .env is never loaded at runtime."""
import os
import psycopg
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from shared.db import database
from shared.repository import Repository


def repository():
    dsn = os.getenv("DATABASE_DSN")
    if dsn:
        engine = create_engine("postgresql+psycopg://", creator=lambda:psycopg.connect(dsn,connect_timeout=10), pool_pre_ping=True, hide_parameters=True)
        return Repository(sessionmaker(engine, expire_on_commit=False))
    _, sessions = database(os.getenv("DATABASE_URL", ""))
    return Repository(sessions)


def secret_file(variable: str, default: str) -> str:
    path = Path(os.getenv(variable, default))
    return path.read_text().strip()
