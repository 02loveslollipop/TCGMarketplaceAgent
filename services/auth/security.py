"""Argon2id, purpose-bound JWTs and transactional TOTP challenges."""
from datetime import datetime, timedelta, timezone
import time
import secrets
import os
from uuid import uuid4

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet
import jwt
import pyotp
from sqlalchemy import select, delete, update

from shared.contracts import utcnow
from shared.db import Challenge, User, EnrollmentState, RecoveryCode, WebAuthnCredential, WebAuthnChallenge, AuditLog


class AuthenticationError(Exception):
    pass


password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, type=Type.ID)
_DUMMY_HASH = password_hasher.hash("constant-time-nonaccount-value")


def hash_password(password: str) -> str:
    if len(password) < 12 or len(password) > 256:
        raise ValueError("Password must contain 12 to 256 characters.")
    return password_hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    if len(password) > 256:
        return False
    try:
        return password_hasher.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerificationError, InvalidHashError):
        return False


class Tokens:
    def __init__(self, public_key: str, private_key: str | None = None):
        self.public_key, self.private_key = public_key, private_key

    def issue(self, user: User, kind="access", challenge_id=None, *, dev_session=None, orig_iat: int | None = None) -> str:
        now = utcnow()
        access_ttl = int(os.getenv("ACCESS_TOKEN_TTL_MINUTES", "480"))
        payload = {"sub":user.id, "iss":"pokemon-tcg-auth", "aud":"pokemon-tcg-poc",
                   "iat":now, "nbf":now, "exp":now + timedelta(minutes=access_ttl if kind == "access" else 5),
                   "jti":str(uuid4()), "type":kind, "version":user.token_version}
        if kind == "access":
            if orig_iat is None:
                payload["orig_iat"] = int(now.timestamp())
            elif isinstance(orig_iat, datetime):
                payload["orig_iat"] = int(orig_iat.timestamp())
            else:
                payload["orig_iat"] = int(orig_iat)
        if challenge_id:
            payload["challenge_id"] = challenge_id
        if dev_session is not None:
            payload["dev_session"] = dev_session
        return jwt.encode(payload, self.private_key, algorithm="RS256")

    def read(self, token: str, kind="access") -> dict:
        try:
            claims = jwt.decode(token, self.public_key, algorithms=["RS256"],
                                issuer="pokemon-tcg-auth", audience="pokemon-tcg-poc",
                                options={"require":["sub", "exp", "iat", "nbf", "jti", "type", "version"]})
            if claims["type"] != kind:
                raise AuthenticationError("Token has incorrect purpose.")
            return claims
        except jwt.InvalidTokenError as error:
            raise AuthenticationError("Invalid or expired token.") from error

    def read_for_refresh(self, token: str, kind="access", max_grace_seconds: int | None = None) -> dict:
        if max_grace_seconds is None:
            try:
                max_grace_seconds = int(os.getenv("REFRESH_GRACE_SECONDS", "86400"))
            except Exception:
                max_grace_seconds = 86400

        try:
            max_session_hours = int(os.getenv("MAX_SESSION_HOURS", "168"))
        except Exception:
            max_session_hours = 168
        max_session_seconds = max_session_hours * 3600

        now_ts = int(time.time())
        claims = None
        try:
            claims = self.read(token, kind)
        except AuthenticationError:
            try:
                claims = jwt.decode(
                    token, self.public_key, algorithms=["RS256"],
                    issuer="pokemon-tcg-auth", audience="pokemon-tcg-poc",
                    options={"verify_exp": False, "require": ["sub", "exp", "iat", "nbf", "jti", "type", "version"]},
                )
            except jwt.InvalidTokenError as decode_err:
                raise AuthenticationError("Invalid token signature or claims.") from decode_err

            if claims.get("type") != kind:
                raise AuthenticationError("Token has incorrect purpose.")

            exp = claims.get("exp", 0)
            if now_ts - exp > max_grace_seconds:
                raise AuthenticationError("Token expired beyond refresh grace period.")

        orig_iat = claims.get("orig_iat")
        if orig_iat is None:
            orig_iat = claims.get("iat", 0)
        orig_iat_ts = int(orig_iat)

        if now_ts - orig_iat_ts > max_session_seconds:
            raise AuthenticationError("Session has exceeded maximum allowed duration.")

        return claims


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


class Security:
    def __init__(self, repo, tokens: Tokens, encryption_key: bytes, *, local_password_only: bool = False):
        self.repo, self.tokens, self.cipher = repo, tokens, Fernet(encryption_key)
        self._local_password_only = local_password_only
        # Restarting the auth service invalidates password-only sessions even if
        # the switch is later re-enabled, preventing old sessions from reviving.
        self._dev_session = secrets.token_urlsafe(32) if local_password_only else None

    def current(self, token: str, kind="access") -> User:
        claims = self.tokens.read(token, kind)
        user = self.repo.user(user_id=claims["sub"])
        if not user or not user.active or user.token_version != claims["version"]:
            raise AuthenticationError("Account or session is unavailable.")
        if kind == "access":
            dev_session = claims.get("dev_session")
            if dev_session is not None:
                if not self._local_password_only or not secrets.compare_digest(str(dev_session), self._dev_session):
                    raise AuthenticationError("Development session is unavailable.")
            elif not self.has_factor(user):
                raise AuthenticationError("Complete second-factor enrollment before using this application.")
        if kind == "enrollment":
            with self.repo.transaction() as session:
                self.enrollment_parent(session,user,claims.get("challenge_id"))
        return user

    def current_for_refresh(self, token: str, kind="access", max_grace_seconds: int | None = None) -> User:
        claims = self.tokens.read_for_refresh(token, kind, max_grace_seconds)
        user = self.repo.user(user_id=claims["sub"])
        if not user or not user.active or user.token_version != claims["version"]:
            raise AuthenticationError("Account or session is unavailable.")
        if kind == "access":
            dev_session = claims.get("dev_session")
            if dev_session is not None:
                if not self._local_password_only or not secrets.compare_digest(str(dev_session), self._dev_session):
                    raise AuthenticationError("Development session is unavailable.")
            elif not self.has_factor(user):
                raise AuthenticationError("Complete second-factor enrollment before using this application.")
        return user

    def has_factor(self,user):
        return bool(user.totp_secret or self.repo.webauthn_credentials(user.id))

    @staticmethod
    def session_factor(session,user):
        return bool(user.totp_secret or session.scalar(select(WebAuthnCredential.id).where(WebAuthnCredential.user_id==user.id)))

    def enrollment_parent(self,session,user,challenge_id):
        stored=session.scalar(select(User).where(User.id==user.id).with_for_update())
        parent=session.scalar(select(Challenge).where(Challenge.id==challenge_id,Challenge.user_id==user.id).with_for_update())
        if not stored or not stored.active or stored.token_version!=user.token_version or self.session_factor(session,stored):
            raise AuthenticationError("Enrollment state changed; sign in again.")
        if not parent or parent.kind!="enrollment" or parent.consumed or aware(parent.expires_at)<=utcnow() or parent.attempts>=5:
            raise AuthenticationError("Enrollment expired or consumed; sign in again.")
        return stored,parent

    def login(self, username: str, password: str) -> dict:
        user = self.repo.user(username=username)
        valid = verify_password(user.password_hash if user else None, password)
        if not valid or not user or not user.active:
            raise AuthenticationError("Invalid credentials.")
        if self._local_password_only:
            return {"access_token":self.tokens.issue(user, dev_session=self._dev_session),
                    "token_type":"bearer", "expires_in":900}
        credentials=self.repo.webauthn_credentials(user.id)
        if user.totp_secret or credentials:
            challenge = self.repo.add_challenge(user.id, "second_factor_login", utcnow() + timedelta(minutes=5))
            return {"requires_2fa":True, "challenge_token":self.tokens.issue(user, "second_factor", challenge.id),
                    "methods":(["webauthn"] if credentials else [])+(["totp"] if user.totp_secret else [])+(["recovery"] if self.recovery_remaining(user) else [])}
        challenge=self.repo.add_challenge(user.id,"enrollment",utcnow()+timedelta(minutes=5))
        return {"requires_enrollment":True,"enrollment_token":self.tokens.issue(user,"enrollment",challenge.id)}

    def onboarding_totp(self,token,code=None):
        user=self.current(token,"enrollment")
        claims=self.tokens.read(token,"enrollment")
        failure=None
        result=None
        with self.repo.transaction() as session:
            stored,parent=self.enrollment_parent(session,user,claims["challenge_id"])
            state=session.get(EnrollmentState,parent.id)
            if code is None:
                secret=pyotp.random_base32()
                if state is None:
                    state=EnrollmentState(enrollment_id=parent.id);session.add(state)
                state.totp_secret=self.cipher.encrypt(secret.encode()).decode()
                return {"secret":secret,"uri":pyotp.TOTP(secret).provisioning_uri(user.username,issuer_name="Pokemon TCG PoC")}
            if not state or not state.totp_secret:
                raise AuthenticationError("Start authenticator enrollment first.")
            parent.attempts+=1
            try:
                step=self.verify_code(self.cipher.decrypt(state.totp_secret.encode()).decode(),code,-1)
                stored.totp_secret=state.totp_secret;stored.totp_last_step=step
                state.totp_secret=None;parent.consumed=True
                codes=self.replace_recovery(session,stored)
                stored.token_version+=1
                result={"enrolled":True,"sign_in_again":True,"recovery_codes":codes}
            except AuthenticationError as error:
                failure=error
        if failure:raise failure
        return result

    @staticmethod
    def replace_recovery(session,user):
        session.execute(delete(RecoveryCode).where(RecoveryCode.user_id==user.id))
        codes=[secrets.token_hex(16).upper() for _ in range(10)]
        session.add_all([RecoveryCode(user_id=user.id,code_hash=password_hasher.hash(code)) for code in codes])
        return ["-".join(code[i:i+4] for i in range(0,len(code),4)) for code in codes]

    def recovery_remaining(self,user):
        with self.repo.transaction() as session:
            return len(list(session.scalars(select(RecoveryCode.id).where(RecoveryCode.user_id==user.id,RecoveryCode.consumed.is_(False)))))

    def regenerate_recovery(self,user,password):
        with self.repo.transaction() as session:
            stored=session.scalar(select(User).where(User.id==user.id).with_for_update())
            if not stored or not stored.active or stored.token_version!=user.token_version or not self.session_factor(session,stored) or not verify_password(stored.password_hash,password):
                raise AuthenticationError("Account or password could not be verified.")
            codes=self.replace_recovery(session,stored)
            stored.token_version+=1
        return {"recovery_codes":codes,"sign_in_again":True}

    def recover(self,token,code):
        user=self.current(token,"second_factor")
        claims=self.tokens.read(token,"second_factor")
        failure=None
        with self.repo.transaction() as session:
            stored=session.scalar(select(User).where(User.id==user.id).with_for_update())
            parent=session.scalar(select(Challenge).where(Challenge.id==claims.get("challenge_id"),Challenge.user_id==user.id).with_for_update())
            if not stored or not stored.active or stored.token_version!=claims["version"] or not self.session_factor(session,stored) or not parent or parent.kind!="second_factor_login" or parent.consumed or aware(parent.expires_at)<=utcnow() or parent.attempts>=5:
                raise AuthenticationError("Second-factor challenge expired or consumed.")
            parent.attempts+=1
            normalized=code.replace("-","").replace(" ","").upper()
            rows=list(session.scalars(select(RecoveryCode).where(RecoveryCode.user_id==user.id,RecoveryCode.consumed.is_(False)).with_for_update()))
            match=next((row for row in rows if verify_password(row.code_hash,normalized)),None)
            if match:
                # Recovery resets the factors atomically; it never issues app access.
                stored.totp_secret=None;stored.totp_pending=None;stored.totp_last_step=-1
                stored.token_version+=1
                session.execute(delete(WebAuthnCredential).where(WebAuthnCredential.user_id==stored.id))
                session.execute(delete(RecoveryCode).where(RecoveryCode.user_id==stored.id))
                session.execute(update(Challenge).where(Challenge.user_id==stored.id).values(consumed=True))
                session.execute(update(WebAuthnChallenge).where(WebAuthnChallenge.user_id==stored.id).values(consumed=True))
                enrollment=Challenge(user_id=stored.id,kind="enrollment",expires_at=utcnow()+timedelta(minutes=5))
                session.add(enrollment);session.flush()
                result={"requires_enrollment":True,"recovery_reset":True,
                        "enrollment_token":self.tokens.issue(stored,"enrollment",enrollment.id)}
            else:failure=AuthenticationError("Invalid or already used recovery code.")
        if failure:raise failure
        return result

    def change_role(self,actor,user_id,role):
        with self.repo.transaction() as session:
            rows=list(session.scalars(select(User).where((User.role=="admin")|(User.id==user_id)|(User.id==actor.id)).order_by(User.id).with_for_update()))
            caller=next((row for row in rows if row.id==actor.id),None)
            target=next((row for row in rows if row.id==user_id),None)
            if not caller or not caller.active or caller.role!="admin" or caller.token_version!=actor.token_version:
                raise AuthenticationError("Administrator session is unavailable.")
            if not target:raise ValueError("Account not found.")
            if target.role=="admin" and role!="admin" and target.active and sum(row.active and row.role=="admin" for row in rows)<=1:
                raise ValueError("The last active administrator cannot be demoted.")
            changed=target.role!=role
            if changed:
                old=target.role;target.role=role;target.token_version+=1
                session.add(AuditLog(action="account_role_changed",details={"actor_id":actor.id,"account_id":target.id,"from_role":old,"to_role":role}))
            return {"id":target.id,"username":target.username,"role":target.role,"active":target.active,"sign_in_again":changed and actor.id==target.id}

    def enroll_totp(self, user: User) -> dict:
        if user.totp_secret:
            raise ValueError("Authenticator is already enrolled.")
        secret = pyotp.random_base32()
        self.repo.update_user(user.id, totp_pending=self.cipher.encrypt(secret.encode()).decode())
        return {"secret":secret, "uri":pyotp.TOTP(secret).provisioning_uri(user.username, issuer_name="Pokemon TCG PoC")}

    def confirm_totp(self, user: User, code: str):
        if not user.totp_pending:
            raise AuthenticationError("Start authenticator enrollment first.")
        secret = self.cipher.decrypt(user.totp_pending.encode()).decode()
        step = self.verify_code(secret, code, -1)
        self.repo.update_user(user.id, totp_secret=user.totp_pending, totp_pending=None, totp_last_step=step,
                              token_version=user.token_version + 1)

    @staticmethod
    def verify_code(secret: str, code: str, last_step: int) -> int:
        now = int(time.time()) // 30
        for step in (now - 1, now, now + 1):
            if step > last_step and pyotp.TOTP(secret).verify(code, for_time=step * 30):
                return step
        raise AuthenticationError("Invalid or already used authenticator code.")

    def second_factor(self, challenge_token: str, code: str) -> dict:
        user = self.current(challenge_token, "second_factor")
        claims = self.tokens.read(challenge_token, "second_factor")
        failure = None
        with self.repo.transaction() as session:
            stored_user = session.scalar(select(User).where(User.id == user.id).with_for_update())
            challenge = session.scalar(select(Challenge).where(Challenge.id == claims["challenge_id"], Challenge.user_id == user.id).with_for_update())
            if not challenge or challenge.kind!="second_factor_login" or challenge.consumed or aware(challenge.expires_at) <= utcnow() or challenge.attempts >= 5:
                raise AuthenticationError("Second-factor challenge expired or consumed.")
            if not stored_user or not stored_user.active or stored_user.token_version!=claims["version"] or not stored_user.totp_secret:
                raise AuthenticationError("Authenticator app is unavailable for this account/session.")
            challenge.attempts += 1
            try:
                secret = self.cipher.decrypt(stored_user.totp_secret.encode()).decode()
                stored_user.totp_last_step = self.verify_code(secret, code, stored_user.totp_last_step)
                challenge.consumed = True
            except AuthenticationError as error:
                failure = error
        if failure:
            raise failure
        return {"access_token":self.tokens.issue(stored_user), "token_type":"bearer", "expires_in":900}
