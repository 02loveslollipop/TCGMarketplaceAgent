"""Short transactions and owner-scoped access to durable application state."""
from contextlib import contextmanager
from datetime import datetime, timedelta
import re

from sqlalchemy import delete, func, or_, select, update

from shared.contracts import utcnow
from shared.db import (
    AuditLog,
    BannedCard,
    Challenge,
    Conversation,
    Event,
    Execution,
    GraphCheckpoint,
    LegalitySet,
    LegalitySyncState,
    Message,
    ModelPolicy,
    User,
    UserPreference,
    WebAuthnCredential,
)


class NotFound(Exception):
    pass


SECRET_FIELDS = re.compile(r"password|secret|token|api.?key|authorization|credential|recovery|code_hash", re.I)


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if SECRET_FIELDS.search(key) else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(?i)(bearer\s+|(?:sk-|apify_api_|tcg_api_))[\w.\-]+", "[REDACTED]", value)
    return value


class Repository:
    def __init__(self, sessions):
        self.sessions = sessions

    @contextmanager
    def transaction(self):
        with self.sessions() as session, session.begin():
            yield session

    def add_user(self, username: str, password_hash: str, role="user", iam_role_id=None) -> User:
        with self.transaction() as session:
            user = User(username=username, password_hash=password_hash, role=role, iam_role_id=iam_role_id)
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

    def rename_conversation(self, conversation_id: str, user_id: str, title: str) -> Conversation:
        cleaned_title = title.strip()[:160]
        if not cleaned_title:
            raise ValueError("Conversation title cannot be empty")
        with self.transaction() as session:
            row = session.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id))
            if row is None:
                raise NotFound("Conversation not found")
            row.title = cleaned_title
            session.flush()
            return row

    def delete_conversation(self, conversation_id: str, user_id: str):
        with self.transaction() as session:
            conv = session.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id))
            if conv is None:
                raise NotFound("Conversation not found")
            exec_ids = list(session.scalars(select(Execution.id).where(Execution.conversation_id == conversation_id, Execution.user_id == user_id)))
            if exec_ids:
                session.execute(delete(Event).where(Event.execution_id.in_(exec_ids)))
                session.execute(delete(Execution).where(Execution.id.in_(exec_ids)))
                session.execute(delete(GraphCheckpoint).where(GraphCheckpoint.thread_id.in_([*exec_ids, conversation_id])))
            else:
                session.execute(delete(GraphCheckpoint).where(GraphCheckpoint.thread_id == conversation_id))
            session.execute(delete(Message).where(Message.conversation_id == conversation_id))
            session.delete(conv)

    def user_preferences(self, user_id: str) -> dict:
        with self.transaction() as session:
            pref = session.get(UserPreference, user_id)
            if pref:
                return {"ruleset": pref.ruleset, "format": pref.format, "location": pref.location,
                        "target_currency": pref.target_currency, "updated_at": pref.updated_at.isoformat()}
            return {"ruleset": "auto", "format": "auto", "location": "", "target_currency": None, "updated_at": None}

    def save_user_preferences(self, user_id: str, ruleset: str, format_: str | None = None, format: str | None = None,
                              *, location: str = "", target_currency: str | None = None) -> dict:
        fmt = format_ if format_ is not None else format
        valid_rulesets = {"auto", "international", "japan"}
        valid_formats = {"auto", "standard", "expanded"}
        r = ruleset.lower().strip() if ruleset else "auto"
        f = fmt.lower().strip() if fmt else "auto"
        if r not in valid_rulesets:
            raise ValueError(f"Invalid ruleset: {ruleset}")
        if f not in valid_formats:
            raise ValueError(f"Invalid format: {fmt}")
        with self.transaction() as session:
            pref = session.get(UserPreference, user_id)
            if pref is None:
                pref = UserPreference(user_id=user_id, ruleset=r, format=f, updated_at=utcnow())
                session.add(pref)
            else:
                pref.ruleset = r
                pref.format = f
                pref.updated_at = utcnow()
            pref.location = location.strip()
            pref.target_currency = target_currency
            session.flush()
            return {"ruleset": pref.ruleset, "format": pref.format, "location": pref.location,
                    "target_currency": pref.target_currency, "updated_at": pref.updated_at.isoformat()}

    def legality_status(self) -> dict:
        with self.transaction() as session:
            row = session.get(LegalitySyncState, "current")
            if row is None:
                return {
                    "status": "not_initialized",
                    "last_refreshed_at": None,
                    "next_refresh_at": None,
                    "triggered_by": None,
                    "international_standard_marks": [],
                    "japan_standard_marks": [],
                    "sets_count": 0,
                    "banned_count": 0,
                    "sources": [],
                    "error": None,
                }
            return {
                "status": row.status,
                "last_refreshed_at": row.last_refreshed_at.isoformat() if row.last_refreshed_at else None,
                "next_refresh_at": row.next_refresh_at.isoformat() if row.next_refresh_at else None,
                "triggered_by": row.triggered_by,
                "international_standard_marks": row.international_standard_marks or [],
                "japan_standard_marks": row.japan_standard_marks or [],
                "sets_count": row.sets_count,
                "banned_count": row.banned_count,
                "sources": row.sources or [],
                "error": row.error,
            }

    def record_legality_failure(self, triggered_by: str):
        with self.transaction() as session:
            row = session.get(LegalitySyncState, "current")
            if row is None:
                row = LegalitySyncState(id="current")
                session.add(row)
            row.status = "failed"
            row.triggered_by = triggered_by
            row.error = "Current rules could not be refreshed. Previous data is retained and remains unverified."
            row.next_refresh_at = utcnow() + timedelta(hours=1)

    def replace_legality_catalog(self, *, sets: list[dict], bans: list[dict], sync_state: dict):
        with self.transaction() as session:
            session.execute(delete(LegalitySet))
            session.execute(delete(BannedCard))
            for item in sets:
                session.add(LegalitySet(
                    id=item["id"],
                    ruleset=item["ruleset"],
                    tcgdex_id=item["tcgdex_id"],
                    set_code=item["set_code"],
                    name=item["name"],
                    series=item.get("series", ""),
                    release_date=item.get("release_date"),
                    legal_standard=bool(item.get("legal_standard", False)),
                    legal_expanded=bool(item.get("legal_expanded", False)),
                    card_count=int(item.get("card_count", 0)),
                    updated_at=utcnow(),
                ))
            for item in bans:
                session.add(BannedCard(
                    id=item["id"],
                    ruleset=item["ruleset"],
                    format=item["format"],
                    card_id=item.get("card_id"),
                    card_name=item["card_name"],
                    card_name_ja=item.get("card_name_ja"),
                    set_code=item.get("set_code", ""),
                    set_name=item.get("set_name"),
                    card_number=item.get("card_number", ""),
                    reason=item.get("reason"),
                    source_url=item.get("source_url", ""),
                    updated_at=utcnow(),
                ))
            state_row = session.get(LegalitySyncState, "current")
            if state_row is None:
                state_row = LegalitySyncState(id="current")
                session.add(state_row)
            state_row.status = sync_state.get("status", "synced")
            state_row.last_refreshed_at = sync_state.get("last_refreshed_at") or utcnow()
            state_row.next_refresh_at = sync_state.get("next_refresh_at")
            state_row.triggered_by = sync_state.get("triggered_by", "system")
            state_row.international_standard_marks = sync_state.get("international_standard_marks", [])
            state_row.japan_standard_marks = sync_state.get("japan_standard_marks", [])
            state_row.sets_count = len(sets)
            state_row.banned_count = len(bans)
            state_row.sources = sync_state.get("sources", [])
            state_row.error = sync_state.get("error")
            session.flush()

    def query_legality_catalog(
        self,
        *,
        ruleset: str | None = None,
        format_: str | None = None,
        format: str | None = None,
        set_query: str | None = None,
        card_query: str | None = None,
        card_name: str | None = None,
        limit: int = 500,
    ) -> dict:
        actual_format = format_ or format
        actual_card_query = card_query or card_name
        with self.transaction() as session:
            status = self.legality_status()
            sets_q = select(LegalitySet)
            if ruleset:
                sets_q = sets_q.where(LegalitySet.ruleset == ruleset.lower())
            if actual_format == "standard":
                sets_q = sets_q.where(LegalitySet.legal_standard.is_(True))
            elif actual_format == "expanded":
                sets_q = sets_q.where(LegalitySet.legal_expanded.is_(True))
            if set_query:
                sq = f"%{set_query.strip().lower()}%"
                sets_q = sets_q.where(or_(
                    func.lower(LegalitySet.set_code).like(sq),
                    func.lower(LegalitySet.tcgdex_id).like(sq),
                    func.lower(LegalitySet.name).like(sq),
                ))
            sets_q = sets_q.order_by(LegalitySet.release_date.desc().nullslast(), LegalitySet.name).limit(limit)
            matched_sets = [
                {
                    "id": s.id,
                    "ruleset": s.ruleset,
                    "tcgdex_id": s.tcgdex_id,
                    "set_code": s.set_code,
                    "name": s.name,
                    "series": s.series,
                    "release_date": s.release_date,
                    "legal_standard": s.legal_standard,
                    "legal_expanded": s.legal_expanded,
                    "card_count": s.card_count,
                }
                for s in session.scalars(sets_q)
            ]

            bans_q = select(BannedCard)
            if ruleset:
                bans_q = bans_q.where(BannedCard.ruleset == ruleset.lower())
            if actual_format:
                bans_q = bans_q.where(BannedCard.format == actual_format.lower())
            if actual_card_query:
                cq = f"%{actual_card_query.strip().lower()}%"
                bans_q = bans_q.where(or_(
                    func.lower(BannedCard.card_name).like(cq),
                    func.lower(func.coalesce(BannedCard.card_name_ja, "")).like(cq),
                    func.lower(func.coalesce(BannedCard.card_id, "")).like(cq),
                    func.lower(BannedCard.set_code).like(cq),
                ))
            bans_q = bans_q.order_by(BannedCard.ruleset, BannedCard.format, BannedCard.card_name).limit(limit)
            matched_bans = [
                {
                    "id": b.id,
                    "ruleset": b.ruleset,
                    "format": b.format,
                    "card_id": b.card_id,
                    "card_name": b.card_name,
                    "card_name_ja": b.card_name_ja,
                    "set_code": b.set_code,
                    "set_name": b.set_name,
                    "card_number": b.card_number,
                    "reason": b.reason,
                    "source_url": b.source_url,
                }
                for b in session.scalars(bans_q)
            ]

            return {
                "sync_state": status,
                "sets": matched_sets,
                "banned_cards": matched_bans,
            }

    def resolve_set_code(self, set_code_or_id: str, ruleset: str = "international") -> str | None:
        target = set_code_or_id.strip()
        if not target:
            return None
        with self.transaction() as session:
            row = session.scalar(select(LegalitySet).where(
                LegalitySet.ruleset == ruleset.lower(),
                or_(
                    func.lower(LegalitySet.set_code) == target.lower(),
                    func.lower(LegalitySet.tcgdex_id) == target.lower(),
                )
            ))
            return row.tcgdex_id if row else None

    def admin_executions(self, limit: int = 50) -> list[dict]:
        with self.transaction() as session:
            rows = session.execute(
                select(Execution, Conversation.title)
                .outerjoin(Conversation, Execution.conversation_id == Conversation.id)
                .order_by(Execution.created_at.desc())
                .limit(limit)
            ).all()
            return [
                {
                    "id": e.id,
                    "conversation_id": e.conversation_id,
                    "conversation_title": title or "Untitled",
                    "user_id": e.user_id,
                    "model_id": e.model_id,
                    "status": e.status,
                    "created_at": e.created_at.isoformat(),
                }
                for e, title in rows
            ]

    def admin_execution_detail(self, execution_id: str) -> dict:
        with self.transaction() as session:
            row = session.execute(
                select(Execution, Conversation.title)
                .outerjoin(Conversation, Execution.conversation_id == Conversation.id)
                .where(Execution.id == execution_id)
            ).first()
            if not row:
                raise NotFound("Execution not found")
            execution, conv_title = row
            events = list(session.scalars(select(Event).where(Event.execution_id == execution_id).order_by(Event.created_at)))
            logs = list(session.scalars(select(AuditLog).where(AuditLog.execution_id == execution_id).order_by(AuditLog.created_at)))
            checkpoint = execution.checkpoint or {}

            # Deduplicate events by payload id for thinking and tool
            events_deduped = []
            span_map = {}
            for ev in events:
                p = ev.payload or {}
                span_id = p.get("id") if ev.kind in {"thinking", "tool"} else None
                if span_id:
                    if span_id in span_map:
                        idx = span_map[span_id]
                        existing_status = (events_deduped[idx]["payload"] or {}).get("status")
                        new_status = p.get("status")
                        if existing_status == "loading" or new_status in {"complete", "error"}:
                            events_deduped[idx]["payload"] = p
                    else:
                        span_map[span_id] = len(events_deduped)
                        events_deduped.append({
                            "id": ev.id,
                            "kind": ev.kind,
                            "payload": ev.payload,
                            "created_at": ev.created_at.isoformat(),
                        })
                else:
                    events_deduped.append({
                        "id": ev.id,
                        "kind": ev.kind,
                        "payload": ev.payload,
                        "created_at": ev.created_at.isoformat(),
                    })

            provider_summaries = []
            approach_summaries = []
            generic_summaries = []
            for ev in events_deduped:
                if ev["kind"] in {"thinking", "reasoning"}:
                    p = ev["payload"] or {}
                    if p.get("status") != "loading" and p.get("summary"):
                        src = p.get("source")
                        summary_txt = p.get("summary", "").strip()
                        if src == "provider_summary":
                            if summary_txt not in provider_summaries:
                                provider_summaries.append(summary_txt)
                        elif src == "approach_summary":
                            if summary_txt not in approach_summaries:
                                approach_summaries.append(summary_txt)
                        else:
                            if summary_txt not in generic_summaries:
                                generic_summaries.append(summary_txt)

            parts = []
            if provider_summaries:
                parts.append("### Provider Reasoning\n" + "\n\n".join(provider_summaries))
            if approach_summaries:
                parts.append("### Approach Summary\n" + "\n\n".join(approach_summaries))
            if generic_summaries and not parts:
                parts.append("\n\n".join(generic_summaries))
            reasoning_summary = "\n\n".join(parts)

            messages = list(
                session.scalars(
                    select(Message)
                    .where(Message.conversation_id == execution.conversation_id)
                    .order_by(Message.created_at)
                )
            )
            thread_execs = list(
                session.scalars(
                    select(Execution)
                    .where(Execution.conversation_id == execution.conversation_id)
                    .order_by(Execution.created_at)
                )
            )

            return {
                "id": execution.id,
                "conversation_id": execution.conversation_id,
                "conversation_title": conv_title or "Untitled",
                "user_id": execution.user_id,
                "model_id": execution.model_id,
                "status": execution.status,
                "created_at": execution.created_at.isoformat(),
                "checkpoint": checkpoint,
                "reasoning_summary": reasoning_summary,
                "events": events_deduped,
                "messages": [
                    {
                        "id": m.id,
                        "role": m.role,
                        "content": m.content,
                        "created_at": m.created_at.isoformat(),
                    }
                    for m in messages
                ],
                "thread_executions": [
                    {
                        "id": e.id,
                        "model_id": e.model_id,
                        "status": e.status,
                        "created_at": e.created_at.isoformat(),
                    }
                    for e in thread_execs
                ],
                "logs": [
                    {
                        "id": l.id,
                        "action": l.action,
                        "details": l.details,
                        "created_at": l.created_at.isoformat(),
                    }
                    for l in logs
                ],
            }

