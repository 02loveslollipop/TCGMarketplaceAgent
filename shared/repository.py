"""Short transactions and owner-scoped access to durable application state."""
from contextlib import contextmanager
from datetime import datetime
import re

from sqlalchemy import select, update

from shared.db import AuditLog, Challenge, Conversation, Event, Execution, GraphCheckpoint, Message, ModelPolicy, User, WebAuthnCredential


class NotFound(Exception):
    pass


SECRET_FIELDS = re.compile(r"password|secret|token|api.?key|authorization|credential|recovery|code_hash", re.I)


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if SECRET_FIELDS.search(key) else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(?i)(bearer\s+|(?:sk-|apify_api_))[\w.\-]+", "[REDACTED]", value)
    return value


class Repository:
    def __init__(self, sessions):
        self.sessions = sessions

    @contextmanager
    def transaction(self):
        with self.sessions() as session, session.begin():
            yield session

    def add_user(self, username: str, password_hash: str, role="user") -> User:
        with self.transaction() as session:
            user = User(username=username, password_hash=password_hash, role=role)
            session.add(user)
            session.flush()
            return user

    def users(self) -> list[User]:
        with self.transaction() as session:
            return list(session.scalars(select(User).order_by(User.username)))

    def user(self, *, user_id=None, username=None) -> User | None:
        with self.transaction() as session:
            clause = User.id == user_id if user_id else User.username == username
            return session.scalar(select(User).where(clause))

    def update_user(self, user_id: str, **values):
        with self.transaction() as session:
            session.execute(update(User).where(User.id == user_id).values(**values))

    def webauthn_credentials(self, user_id: str):
        with self.transaction() as session:
            return list(session.scalars(select(WebAuthnCredential).where(WebAuthnCredential.user_id == user_id).order_by(WebAuthnCredential.created_at)))

    def add_challenge(self, user_id: str, kind: str, expires_at: datetime) -> Challenge:
        with self.transaction() as session:
            challenge = Challenge(user_id=user_id, kind=kind, expires_at=expires_at)
            session.add(challenge)
            session.flush()
            return challenge

    def models(self, *, enabled_only=False):
        with self.transaction() as session:
            query = select(ModelPolicy).order_by(ModelPolicy.label)
            if enabled_only:
                query = query.where(ModelPolicy.enabled.is_(True))
            return list(session.scalars(query))

    def model(self, model_id: str):
        with self.transaction() as session:
            return session.get(ModelPolicy, model_id)

    def save_model(self, model_id: str, **values):
        with self.transaction() as session:
            model = session.get(ModelPolicy, model_id)
            if model is None:
                model = ModelPolicy(id=model_id, **values)
                session.add(model)
            else:
                for key, value in values.items():
                    setattr(model, key, value)
            session.flush()
            return model

    def new_conversation(self, user_id: str, title: str) -> Conversation:
        with self.transaction() as session:
            conversation = Conversation(user_id=user_id, title=title[:160])
            session.add(conversation)
            session.flush()
            return conversation

    def conversation(self, conversation_id: str, user_id: str) -> Conversation:
        with self.transaction() as session:
            row = session.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id))
            if row is None:
                raise NotFound("Conversation not found")
            return row

    def conversations(self, user_id: str):
        with self.transaction() as session:
            return list(session.scalars(select(Conversation).where(Conversation.user_id == user_id).order_by(Conversation.created_at.desc())))

    def add_message(self, conversation_id: str, user_id: str, role: str, content: dict):
        self.conversation(conversation_id, user_id)
        with self.transaction() as session:
            session.add(Message(conversation_id=conversation_id, role=role, content=content))

    def history(self, conversation_id: str, user_id: str):
        self.conversation(conversation_id, user_id)
        with self.transaction() as session:
            return list(session.scalars(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at)))

    def new_execution(self, conversation_id: str, user_id: str, model_id: str):
        self.conversation(conversation_id, user_id)
        with self.transaction() as session:
            row = Execution(conversation_id=conversation_id, user_id=user_id, model_id=model_id)
            session.add(row)
            session.flush()
            return row

    def execution(self, execution_id: str, user_id: str):
        with self.transaction() as session:
            row = session.scalar(select(Execution).where(Execution.id == execution_id, Execution.user_id == user_id))
            if row is None:
                raise NotFound("Execution not found")
            return row

    def checkpoint(self, execution_id: str, user_id: str, state: dict, status: str):
        self.execution(execution_id, user_id)
        with self.transaction() as session:
            session.execute(update(Execution).where(Execution.id == execution_id, Execution.user_id == user_id).values(checkpoint=state, status=status))

    def claim_execution(self, execution_id: str, user_id: str) -> bool:
        with self.transaction() as session:
            result = session.execute(update(Execution).where(
                Execution.id == execution_id, Execution.user_id == user_id,
                Execution.status == "waiting").values(status="running"))
            return result.rowcount == 1

    def event(self, execution_id: str, user_id: str, kind: str, payload: dict):
        self.execution(execution_id, user_id)
        with self.transaction() as session:
            session.add(Event(execution_id=execution_id, kind=kind, payload=payload))
            session.add(AuditLog(execution_id=execution_id, action=kind, details=redact(payload)))

    def events(self, execution_id: str, user_id: str):
        self.execution(execution_id, user_id)
        with self.transaction() as session:
            return list(session.scalars(select(Event).where(Event.execution_id == execution_id).order_by(Event.created_at)))

    def graph_get(self, thread_id: str):
        with self.transaction() as session:
            row = session.get(GraphCheckpoint, thread_id)
            return row.value if row else None

    def graph_save(self, thread_id: str, value: dict):
        with self.transaction() as session:
            row = session.get(GraphCheckpoint, thread_id)
            if row:
                row.value = value
            else:
                session.add(GraphCheckpoint(thread_id=thread_id, value=value))
