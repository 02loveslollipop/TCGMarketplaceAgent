"""Only app-owned schema objects appear in metadata or queries."""
from datetime import date, datetime
from uuid import uuid4

from sqlalchemy import JSON, BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, MetaData, String, Text, UniqueConstraint, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from shared.contracts import utcnow

SCHEMA = "pokemon_tcg_poc"


def identifier() -> str:
    return str(uuid4())


class Base(DeclarativeBase):
    metadata = MetaData(schema=SCHEMA)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    username: Mapped[str] = mapped_column(String(160), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(16), default="user")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    totp_secret: Mapped[str | None] = mapped_column(Text)
    totp_pending: Mapped[str | None] = mapped_column(Text)
    totp_last_step: Mapped[int] = mapped_column(Integer, default=-1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Challenge(Base):
    __tablename__ = "challenges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class EnrollmentState(Base):
    __tablename__ = "enrollment_states"
    enrollment_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.challenges.id"), primary_key=True)
    totp_secret: Mapped[str | None] = mapped_column(Text)


class RecoveryCode(Base):
    __tablename__ = "recovery_codes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.users.id"), index=True)
    code_hash: Mapped[str] = mapped_column(Text)
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WebAuthnCredential(Base):
    __tablename__ = "webauthn_credentials"
    __table_args__ = (UniqueConstraint("user_id", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.users.id"), index=True)
    credential_id: Mapped[str] = mapped_column(String(1500), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    public_key: Mapped[str] = mapped_column(Text)
    sign_count: Mapped[int] = mapped_column(BigInteger, default=0)
    transports: Mapped[list] = mapped_column(JSON, default=list)
    device_type: Mapped[str] = mapped_column(String(32))
    backed_up: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WebAuthnChallenge(Base):
    __tablename__ = "webauthn_challenges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.users.id"), index=True)
    login_challenge_id: Mapped[str | None] = mapped_column(ForeignKey(f"{SCHEMA}.challenges.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(24))
    challenge: Mapped[str] = mapped_column(String(128))
    name: Mapped[str | None] = mapped_column(String(80))
    token_version: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)


class ModelPolicy(Base):
    __tablename__ = "models"
    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    label: Mapped[str] = mapped_column(String(160))
    provider: Mapped[str] = mapped_column(String(16))
    api_id: Mapped[str] = mapped_column(String(160))
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    title: Mapped[str] = mapped_column(String(160))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    conversation_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.conversations.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Execution(Base):
    __tablename__ = "executions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    conversation_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.conversations.id"), index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    model_id: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(32), default="running")
    checkpoint: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    execution_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.executions.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    execution_id: Mapped[str | None] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(100))
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GraphCheckpoint(Base):
    __tablename__ = "graph_checkpoints"
    thread_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


def database(url: str):
    if not url:
        raise RuntimeError("DATABASE_URL is required; run the provision command first.")
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    options = {"schema_translate_map": {SCHEMA: None}} if url.startswith("sqlite") else {}
    engine = create_engine(url, execution_options=options, pool_pre_ping=True)
    return engine, sessionmaker(engine, expire_on_commit=False)


class RolePolicy(Base):
    __tablename__ = "role_policies"
    role: Mapped[str] = mapped_column(String(16), primary_key=True)
    daily_token_limit: Mapped[int] = mapped_column(BigInteger)
    allowed_model_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)


class DailyTokenUsage(Base):
    __tablename__ = "daily_token_usage"
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    usage_date: Mapped[date] = mapped_column(Date, primary_key=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    active_call_id: Mapped[str | None] = mapped_column(String(36))
    active_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unverified_usage: Mapped[bool] = mapped_column(Boolean, default=False)


class LegalitySet(Base):
    __tablename__ = "card_sets"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    ruleset: Mapped[str] = mapped_column(String(24), index=True)
    tcgdex_id: Mapped[str] = mapped_column(String(32), index=True)
    set_code: Mapped[str] = mapped_column(String(32), index=True)
    name: Mapped[str] = mapped_column(String(200))
    series: Mapped[str] = mapped_column(String(120), default="")
    release_date: Mapped[str | None] = mapped_column(String(32))
    legal_standard: Mapped[bool] = mapped_column(Boolean, default=False)
    legal_expanded: Mapped[bool] = mapped_column(Boolean, default=False)
    card_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class BannedCard(Base):
    __tablename__ = "banned_cards"
    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    ruleset: Mapped[str] = mapped_column(String(24), index=True)
    format: Mapped[str] = mapped_column(String(24), index=True)
    card_id: Mapped[str | None] = mapped_column(String(64), index=True)
    card_name: Mapped[str] = mapped_column(String(200), index=True)
    card_name_ja: Mapped[str | None] = mapped_column(String(200))
    set_code: Mapped[str] = mapped_column(String(32), default="")
    set_name: Mapped[str | None] = mapped_column(String(200))
    card_number: Mapped[str] = mapped_column(String(32), default="")
    reason: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LegalitySyncState(Base):
    __tablename__ = "legality_sync_state"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default="current")
    status: Mapped[str] = mapped_column(String(32), default="never")
    last_refreshed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_refresh_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    triggered_by: Mapped[str | None] = mapped_column(String(80))
    international_standard_marks: Mapped[list] = mapped_column(JSON, default=list)
    japan_standard_marks: Mapped[list] = mapped_column(JSON, default=list)
    sets_count: Mapped[int] = mapped_column(Integer, default=0)
    banned_count: Mapped[int] = mapped_column(Integer, default=0)
    sources: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text)


class UserPreference(Base):
    __tablename__ = "user_preferences"
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    ruleset: Mapped[str] = mapped_column(String(24), default="auto")
    format: Mapped[str] = mapped_column(String(24), default="auto")
    location: Mapped[str] = mapped_column(String(160), default="", server_default="")
    target_currency: Mapped[str | None] = mapped_column(String(3))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

