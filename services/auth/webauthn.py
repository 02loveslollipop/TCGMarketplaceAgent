"""Password-first WebAuthn 2FA verified by maintained py_webauthn.

Ceremony challenges are consumed in a committed atomic update before parsing or
verification, so failures and concurrent replays cannot reuse a ceremony. The
password challenge and credential counter are locked together for final issuance.
"""
from datetime import timedelta
import json
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from webauthn import generate_authentication_options, generate_registration_options, verify_authentication_response, verify_registration_response
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, options_to_json
from webauthn.helpers.structs import AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor, ResidentKeyRequirement, UserVerificationRequirement

from shared.contracts import utcnow
from shared.db import Challenge, User, WebAuthnChallenge, WebAuthnCredential
from services.auth.security import AuthenticationError, aware


class WebAuthn:
    def __init__(self, security, rp_id="localhost", origin="http://localhost:8080"):
        parsed=urlparse(origin)
        if parsed.hostname != rp_id or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("WebAuthn origin must be a fixed origin matching its RP ID.")
        if parsed.scheme != "https" and not (rp_id == "localhost" and parsed.scheme == "http"):
            raise ValueError("WebAuthn requires HTTPS except on localhost.")
        self.security,self.repo,self.rp_id,self.origin=security,security.repo,rp_id,origin.rstrip("/")

    def checked_user(self, session, user):
        stored=session.scalar(select(User).where(User.id==user.id).with_for_update())
        if not stored or not stored.active or stored.token_version != user.token_version:
            raise AuthenticationError("Account or session changed; sign in again.")
        return stored

    @staticmethod
    def top_level_response(response):
        client=json.loads(base64url_to_bytes(response["response"]["clientDataJSON"]))
        if client.get("crossOrigin",False) or client.get("topOrigin"):
            raise ValueError("Cross-origin authentication is unavailable.")

    def parent_login(self, session, user, parent_id):
        parent=session.scalar(select(Challenge).where(Challenge.id==parent_id,Challenge.user_id==user.id).with_for_update())
        if not parent or parent.kind!="second_factor_login" or parent.consumed or aware(parent.expires_at)<=utcnow() or parent.attempts>5:
            raise AuthenticationError("Password challenge expired or consumed; sign in again.")
        return parent

    def begin_registration(self, user, name, enrollment_id=None):
        if not name.strip():
            raise ValueError("Provide a name for this authenticator.")
        with self.repo.transaction() as session:
            user=self.checked_user(session,user)
            if enrollment_id:
                self.security.enrollment_parent(session,user,enrollment_id)
            credentials=list(session.scalars(select(WebAuthnCredential).where(WebAuthnCredential.user_id==user.id)))
            if len(credentials)>=20 or any(row.name==name.strip() for row in credentials):
                raise ValueError("Choose a unique authenticator name; at most 20 authenticators can be enrolled.")
            options=generate_registration_options(rp_id=self.rp_id,rp_name="Pokémon TCG PoC",user_id=UUID(user.id).bytes,user_name=user.username,
                timeout=120000,exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(row.credential_id)) for row in credentials],
                authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.PREFERRED,user_verification=UserVerificationRequirement.REQUIRED))
            ceremony=WebAuthnChallenge(user_id=user.id,login_challenge_id=enrollment_id,purpose="registration",challenge=bytes_to_base64url(options.challenge),name=name.strip(),token_version=user.token_version,expires_at=utcnow()+timedelta(minutes=3))
            session.add(ceremony);session.flush()
            return {"challenge_id":ceremony.id,"options":json.loads(options_to_json(options))}

    def begin_authentication(self, challenge_token):
        user=self.security.current(challenge_token,"second_factor")
        claims=self.security.tokens.read(challenge_token,"second_factor")
        with self.repo.transaction() as session:
            user=self.checked_user(session,user)
            parent=self.parent_login(session,user,claims["challenge_id"])
            if parent.attempts>=5:
                raise AuthenticationError("Second-factor attempt limit reached; sign in again.")
            credentials=list(session.scalars(select(WebAuthnCredential).where(WebAuthnCredential.user_id==user.id)))
            if not credentials:
                raise AuthenticationError("No WebAuthn authenticators are enrolled for this account.")
            options=generate_authentication_options(rp_id=self.rp_id,timeout=120000,user_verification=UserVerificationRequirement.REQUIRED,
                allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(row.credential_id)) for row in credentials])
            ceremony=WebAuthnChallenge(user_id=user.id,login_challenge_id=parent.id,purpose="authentication",challenge=bytes_to_base64url(options.challenge),token_version=user.token_version,expires_at=min(aware(parent.expires_at),utcnow()+timedelta(minutes=3)))
            session.add(ceremony);session.flush()
            return {"challenge_id":ceremony.id,"options":json.loads(options_to_json(options))}

    def claim(self, ceremony_id, user, purpose):
        with self.repo.transaction() as session:
            ceremony=session.scalar(update(WebAuthnChallenge).where(
                WebAuthnChallenge.id==ceremony_id,WebAuthnChallenge.user_id==user.id,WebAuthnChallenge.purpose==purpose,
                WebAuthnChallenge.token_version==user.token_version,WebAuthnChallenge.consumed.is_(False),WebAuthnChallenge.expires_at>utcnow()
            ).values(consumed=True).returning(WebAuthnChallenge))
            if not ceremony:
                raise AuthenticationError("WebAuthn challenge expired, changed or consumed. Start a new attempt.")
            return ceremony

    def finish_registration(self, user, ceremony_id, response, enrollment_id=None):
        ceremony=self.claim(ceremony_id,user,"registration")
        if ceremony.login_challenge_id!=enrollment_id:
            raise AuthenticationError("Authenticator ceremony belongs to another enrollment.")
        try:
            self.top_level_response(response)
            verification=verify_registration_response(credential=response,expected_challenge=base64url_to_bytes(ceremony.challenge),
                expected_rp_id=self.rp_id,expected_origin=self.origin,require_user_presence=True,require_user_verification=True)
        except Exception:
            # Parser/crypto failures are deliberately public, generic and retryable.
            raise AuthenticationError("Authenticator registration could not be verified. Start a new attempt.") from None
        try:
            with self.repo.transaction() as session:
                user=self.checked_user(session,user)
                parent=None
                if enrollment_id:
                    user,parent=self.security.enrollment_parent(session,user,enrollment_id)
                if session.scalar(select(WebAuthnCredential.id).where(WebAuthnCredential.credential_id==bytes_to_base64url(verification.credential_id))):
                    raise AuthenticationError("This authenticator is already registered.")
                transports=response.get("response",{}).get("transports",[])
                allowed={"usb","nfc","ble","internal","hybrid","smart-card"}
                if not isinstance(transports,list) or any(value not in allowed for value in transports):
                    raise AuthenticationError("Invalid authenticator transports. Start a new attempt.")
                session.add(WebAuthnCredential(user_id=user.id,credential_id=bytes_to_base64url(verification.credential_id),name=ceremony.name,
                    public_key=bytes_to_base64url(verification.credential_public_key),sign_count=verification.sign_count,transports=transports,
                    device_type=verification.credential_device_type.value,backed_up=verification.credential_backed_up))
                result={"enrolled":True,"sign_in_again":True}
                if parent:
                    parent.consumed=True
                    result["recovery_codes"]=self.security.replace_recovery(session,user)
                user.token_version+=1
            return result
        except IntegrityError:
            raise AuthenticationError("Authenticator or name already registered. Start a new attempt.") from None

    def finish_authentication(self, challenge_token, ceremony_id, response):
        user=self.security.current(challenge_token,"second_factor")
        claims=self.security.tokens.read(challenge_token,"second_factor")
        ceremony=self.claim(ceremony_id,user,"authentication")
        if ceremony.login_challenge_id != claims["challenge_id"]:
            raise AuthenticationError("WebAuthn ceremony belongs to another password challenge.")
        with self.repo.transaction() as session:
            counted=session.execute(update(Challenge).where(Challenge.id==ceremony.login_challenge_id,Challenge.user_id==user.id,
                Challenge.kind=="second_factor_login",Challenge.consumed.is_(False),Challenge.expires_at>utcnow(),Challenge.attempts<5).values(attempts=Challenge.attempts+1))
            if counted.rowcount!=1:
                raise AuthenticationError("Password challenge expired or consumed; sign in again.")
        with self.repo.transaction() as session:
            user=self.checked_user(session,user)
            parent=self.parent_login(session,user,ceremony.login_challenge_id)
            credential=session.scalar(select(WebAuthnCredential).where(WebAuthnCredential.credential_id==response.get("id"),WebAuthnCredential.user_id==user.id).with_for_update())
            if not credential:
                raise AuthenticationError("Authenticator does not belong to this account.")
            try:
                self.top_level_response(response)
                handle=response.get("response",{}).get("userHandle")
                if handle is not None and base64url_to_bytes(handle)!=UUID(user.id).bytes:
                    raise ValueError("Incorrect user handle")
                verification=verify_authentication_response(credential=response,expected_challenge=base64url_to_bytes(ceremony.challenge),
                    expected_rp_id=self.rp_id,expected_origin=self.origin,credential_public_key=base64url_to_bytes(credential.public_key),
                    credential_current_sign_count=credential.sign_count,require_user_verification=True)
            except Exception:
                raise AuthenticationError("Authenticator assertion could not be verified. Start a new attempt.") from None
            credential.sign_count=verification.new_sign_count
            credential.backed_up=verification.credential_backed_up
            parent.consumed=True
            token=self.security.tokens.issue(user)
        return {"access_token":token,"token_type":"bearer","expires_in":900}

    def cancel(self, user, ceremony_id):
        with self.repo.transaction() as session:
            result=session.execute(update(WebAuthnChallenge).where(WebAuthnChallenge.id==ceremony_id,WebAuthnChallenge.user_id==user.id).values(consumed=True))
            if result.rowcount!=1:
                raise AuthenticationError("Authenticator challenge was not found.")

    def remove(self, user, credential_id):
        with self.repo.transaction() as session:
            user=self.checked_user(session,user)
            credentials=list(session.scalars(select(WebAuthnCredential).where(WebAuthnCredential.user_id==user.id).with_for_update()))
            credential=next((row for row in credentials if row.id==credential_id),None)
            if not credential:
                raise AuthenticationError("Authenticator was not found for this account.")
            if len(credentials)<2 and not user.totp_secret:
                raise ValueError("Enroll another authenticator or TOTP before removing your last authenticator.")
            session.delete(credential)
            user.token_version+=1
        return {"removed":True,"sign_in_again":True}
