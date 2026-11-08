import time
from collections import defaultdict, deque
from fastapi import Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from shared.api import Principal, application, bearer, require_admin
from services.auth.security import AuthenticationError, hash_password
from services.auth.webauthn import WebAuthn


class AccountInput(BaseModel):
    username: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.@-]+$")
    password: str = Field(min_length=12, max_length=256)
    role: str = Field(default="user", pattern=r"^(user|admin)$")


class TotpCode(BaseModel):
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")


class ChallengeInput(TotpCode):
    challenge_token: str = Field(max_length=5000)


class WebAuthnName(BaseModel):
    name: str = Field(min_length=1,max_length=80)


class WebAuthnProof(BaseModel):
    challenge_id: str = Field(min_length=36,max_length=36)
    credential: dict


class PasswordChallenge(BaseModel):
    challenge_token: str = Field(min_length=1,max_length=5000)


class WebAuthnLoginProof(WebAuthnProof,PasswordChallenge):
    pass


class WebAuthnCancellation(BaseModel):
    challenge_token: str | None = Field(default=None,max_length=5000)


class CurrentPassword(BaseModel):
    password: str = Field(min_length=1,max_length=256)


class RecoveryProof(PasswordChallenge):
    code: str = Field(min_length=1,max_length=100)


def create_app(repo, security, webauthn=None):
    app = application("Pokemon authentication")
    webauthn=webauthn or WebAuthn(security)
    attempts = defaultdict(deque)

    def current(token: str = Depends(bearer)):
        try:
            return security.current(token)
        except AuthenticationError as error:
            raise HTTPException(401, str(error)) from None

    app.state.current = current

    def onboarding(token: str=Depends(bearer)):
        security.current(token,"enrollment")
        return token

    @app.post("/onboarding/totp/enrollment")
    def onboarding_totp(token=Depends(onboarding)):
        return security.onboarding_totp(token)

    @app.post("/onboarding/totp/confirmation")
    def onboarding_totp_confirm(body: TotpCode,token=Depends(onboarding)):
        return security.onboarding_totp(token,body.code)

    @app.post("/onboarding/webauthn/registration/options")
    def onboarding_key(body: WebAuthnName,token=Depends(onboarding)):
        user=security.current(token,"enrollment")
        try:
            return webauthn.begin_registration(user,body.name,security.tokens.read(token,"enrollment")["challenge_id"])
        except ValueError as error:
            raise HTTPException(422,str(error)) from None

    @app.post("/onboarding/webauthn/registration/verify")
    def onboarding_key_confirm(body: WebAuthnProof,token=Depends(onboarding)):
        return webauthn.finish_registration(security.current(token,"enrollment"),body.challenge_id,body.credential,security.tokens.read(token,"enrollment")["challenge_id"])

    @app.post("/onboarding/webauthn/challenges/{challenge_id}/cancel")
    def onboarding_cancel(challenge_id: str,token=Depends(onboarding)):
        webauthn.cancel(security.current(token,"enrollment"),challenge_id)
        return {"cancelled":True}

    @app.get("/recovery/status")
    def recovery_status(user=Depends(current)):
        return {"remaining":security.recovery_remaining(user)}

    @app.post("/recovery/regenerate")
    def recovery_regenerate(body: CurrentPassword,user=Depends(current)):
        return security.regenerate_recovery(user,body.password)

    @app.post("/recovery/challenge")
    def recovery_challenge(body: RecoveryProof):
        return security.recover(body.challenge_token,body.code)

    @app.exception_handler(AuthenticationError)
    async def authentication_error(request,error):
        return await app.exception_handlers[HTTPException](request,HTTPException(401,str(error)))

    @app.post("/token")
    def login(request: Request, form: OAuth2PasswordRequestForm = Depends()):
        key = request.client.host if request.client else "local"
        now = time.monotonic()
        queue = attempts[key]
        while queue and now - queue[0] > 60:
            queue.popleft()
        if len(queue) >= 10:
            raise HTTPException(429, "Too many login attempts; wait one minute.")
        queue.append(now)
        try:
            return security.login(form.username, form.password)
        except AuthenticationError as error:
            raise HTTPException(401, str(error)) from None

    @app.get("/session")
    def session(user=Depends(current)):
        credentials=repo.webauthn_credentials(user.id)
        return {"id":user.id, "username":user.username, "role":user.role, "totp_enrolled":bool(user.totp_secret),
                "webauthn_enrolled":bool(credentials),"webauthn_credentials_count":len(credentials)}

    @app.post("/logout")
    def logout(user=Depends(current)):
        repo.update_user(user.id, token_version=user.token_version + 1)
        return {"signed_out":True}

    @app.get("/accounts")
    def accounts(user=Depends(current)):
        require_admin(Principal(user.id, user.username, user.role))
        return [{"id":account.id, "username":account.username, "role":account.role, "active":account.active} for account in repo.users()]

    @app.post("/accounts", status_code=201)
    def create_account(body: AccountInput, user=Depends(current)):
        require_admin(Principal(user.id,user.username,user.role))
        try:
            account = repo.add_user(body.username, hash_password(body.password), body.role)
            return {"id":account.id, "username":account.username, "role":account.role}
        except IntegrityError:
            raise HTTPException(409, "Username already exists.") from None

    @app.post("/totp/enrollment")
    def enrollment(user=Depends(current)):
        try:
            return security.enroll_totp(user)
        except ValueError as error:
            raise HTTPException(409,str(error)) from None

    @app.post("/totp/confirmation")
    def confirmation(body: TotpCode, user=Depends(current)):
        try:
            security.confirm_totp(user,body.code)
            return {"enrolled":True, "sign_in_again":True}
        except AuthenticationError as error:
            raise HTTPException(401,str(error)) from None

    @app.post("/totp/challenge")
    def challenge(body: ChallengeInput):
        try:
            return security.second_factor(body.challenge_token,body.code)
        except AuthenticationError as error:
            raise HTTPException(401,str(error)) from None

    @app.get("/webauthn/credentials")
    def authenticators(user=Depends(current)):
        return [{"id":row.id,"name":row.name,"created_at":row.created_at.isoformat(),"device_type":row.device_type,"backed_up":row.backed_up} for row in repo.webauthn_credentials(user.id)]

    @app.post("/webauthn/registration/options")
    def registration_options(body: WebAuthnName,user=Depends(current)):
        try:
            return webauthn.begin_registration(user,body.name)
        except ValueError as error:
            raise HTTPException(422,str(error)) from None

    @app.post("/webauthn/registration/verify")
    def registration_verify(body: WebAuthnProof,user=Depends(current)):
        return webauthn.finish_registration(user,body.challenge_id,body.credential)

    @app.post("/webauthn/authentication/options")
    def authentication_options(body: PasswordChallenge):
        return webauthn.begin_authentication(body.challenge_token)

    @app.post("/webauthn/authentication/verify")
    def authentication_verify(body: WebAuthnLoginProof):
        return webauthn.finish_authentication(body.challenge_token,body.challenge_id,body.credential)

    @app.post("/webauthn/challenges/{challenge_id}/cancel")
    def cancel_ceremony(challenge_id: str,body: WebAuthnCancellation,request: Request):
        if body.challenge_token:
            user=security.current(body.challenge_token,"second_factor")
        else:
            authorization=request.headers.get("Authorization","")
            if not authorization.startswith("Bearer "):
                raise AuthenticationError("An authenticated session is required.")
            user=security.current(authorization[7:])
        webauthn.cancel(user,challenge_id)
        return {"cancelled":True}

    @app.delete("/webauthn/credentials/{credential_id}")
    def remove_authenticator(credential_id: str,user=Depends(current)):
        try:
            return webauthn.remove(user,credential_id)
        except ValueError as error:
            raise HTTPException(409,str(error)) from None

    return app
