import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from shared.db import Base, SCHEMA
from shared.repository import Repository


@pytest.fixture
def repo():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
                           execution_options={"schema_translate_map": {SCHEMA: None}})
    Base.metadata.create_all(engine)
    yield Repository(sessionmaker(engine, expire_on_commit=False))
    engine.dispose()
