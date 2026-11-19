"""Authorization-code grants for the public TCG clients."""

import base64
import hashlib
import json
import os
import re
import secrets
import time
from typing import Annotated, Literal
from urllib.parse import urlencode, urlsplit

import psycopg
from fastapi import Depends, Form, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from shared.api import bearer, has_permission, require_permission


PKCE_CHALLENGE = r"^[A-Za-z0-9_-]{43}$"
PKCE_VERIFIER = r"^[A-Za-z0-9._~-]{43,128}$"
STATE = r"^[A-Za-z0-9._~-]{22,128}$"
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer"}


class Authorization(BaseModel):
    response_type: Literal["code"]
    client_id: str = Field(min_length=1, max_length=60)
    redirect_uri: str = Field(min_length=1, max_length=2048)
    state: str = Field(pattern=STATE)
    code_challenge: str = Field(pattern=PKCE_CHALLENGE)
    code_challenge_method: Literal["S256"]


def digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("ascii")).digest()


def validate_redirect(uri: str) -> bool:
    parts = urlsplit(uri)
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        return False
    if parts.scheme == "https":
        return bool(parts.hostname)
    if parts.scheme == "http":
        return parts.hostname in {"localhost", "127.0.0.1", "::1"}
    return "." in parts.scheme and uri.startswith(f"{parts.scheme}:/") and not parts.netloc


def install_tcg_oauth(app, security, serialize_session, guard, principal_for):
    database_url = os.getenv("TCG_OAUTH_DATABASE_URL", "")
    portal_url = os.getenv("TCG_OAUTH_PORTAL_URL", "")
    clients = json.loads(os.getenv("TCG_OAUTH_CLIENTS", "{}"))
    if not isinstance(clients, dict) or any(
        not isinstance(uris, list) or not all(isinstance(uri, str) and validate_redirect(uri) for uri in uris)
        for uris in clients.values()
    ):
        raise ValueError("TCG_OAUTH_CLIENTS must map client IDs to lists of redirect URLs.")
    if portal_url and (not validate_redirect(portal_url) or urlsplit(portal_url).scheme not in {"http", "https"}):
        raise ValueError("TCG_OAUTH_PORTAL_URL must be the shared portal's base URL.")

    def allowed(client_id: str, redirect_uri: str) -> bool:
        return redirect_uri in clients.get(client_id, ())

    def configure():
        if not database_url or not portal_url or not clients:
            raise HTTPException(503, "TCG Manager sign-in is unavailable.")

    def error(code: str, status_code: int = 400):
        return JSONResponse({"error": code}, status_code=status_code, headers=NO_STORE)

    @app.get("/oauth2/authorize")
    def authorize(query: Annotated[Authorization, Depends()]):
        configure()
        if not allowed(query.client_id, query.redirect_uri):
            return error("invalid_request")
        return RedirectResponse(f"{portal_url}?{urlencode(query.model_dump())}", status_code=303, headers=NO_STORE)

    @app.post("/oauth2/authorize")
    def create_grant(query: Authorization, request: Request, response: Response, token: str = Depends(bearer)):
        configure()
        if not allowed(query.client_id, query.redirect_uri):
            return error("invalid_request")
        guard(request, "tcg-authorize")
        user = security.current(token)
        claims = security.tokens.read(token)
        if claims.get("dev_session") is not None:
            raise HTTPException(403, "Sign in with a second factor to use TCG Manager.")
        code = secrets.token_urlsafe(32)
        with psycopg.connect(database_url, connect_timeout=5) as db:
            db.execute("DELETE FROM tcg_manager.oauth_grants WHERE expires_at <= now()")
            db.execute(
                """INSERT INTO tcg_manager.oauth_grants
                   (code_digest, client_id, redirect_uri, challenge, user_id, token_version,
                    original_issued_at, session_expires_at, expires_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,
                           least(now() + interval '90 seconds', to_timestamp(%s)))""",
                (
                    digest(code), query.client_id, query.redirect_uri, query.code_challenge, user.id,
                    user.token_version, claims.get("orig_iat", claims["iat"]), claims["exp"], claims["exp"],
                ),
            )
        response.headers.update(NO_STORE)
        # Preserve the single-slash spelling of registered native callbacks.
        return {"redirect_uri": query.redirect_uri + "?" + urlencode({"code": code, "state": query.state})}

    @app.post("/oauth2/token")
    def exchange(
        request: Request,
        grant_type: Annotated[str, Form(max_length=60)],
        code: Annotated[str, Form(max_length=128)],
        code_verifier: Annotated[str, Form(max_length=128)],
        client_id: Annotated[str, Form(max_length=60)],
        redirect_uri: Annotated[str, Form(max_length=2048)],
    ):
        configure()
        guard(request, "tcg-exchange", limit=30)
        if grant_type != "authorization_code":
            return error("unsupported_grant_type")
        if not allowed(client_id, redirect_uri) or not re.fullmatch(PKCE_CHALLENGE, code) or not re.fullmatch(PKCE_VERIFIER, code_verifier):
            return error("invalid_grant")
        challenge = base64.urlsafe_b64encode(digest(code_verifier)).decode("ascii").rstrip("=")
        with psycopg.connect(database_url, connect_timeout=5, row_factory=dict_row) as db:
            grant = db.execute(
                """DELETE FROM tcg_manager.oauth_grants
                   WHERE code_digest = %s AND client_id = %s AND redirect_uri = %s
                     AND challenge = %s AND expires_at > now()
                   RETURNING user_id, token_version, original_issued_at, session_expires_at""",
                (digest(code), client_id, redirect_uri, challenge),
            ).fetchone()
        if not grant:
            return error("invalid_grant")
        user = security.repo.user(user_id=grant["user_id"])
        if not user or not user.active or user.token_version != grant["token_version"] or not security.has_factor(user):
            return error("invalid_grant")
        access = security.tokens.issue(
            user, "tcg_access", orig_iat=grant["original_issued_at"], expires_at=grant["session_expires_at"],
        )
        expires = security.tokens.read(access, "tcg_access")["exp"] - int(time.time())
        return JSONResponse({
            "access_token": access, "token_type": "Bearer", "expires_in": expires,
        }, headers=NO_STORE)

    @app.get("/oauth2/session")
    def session(response: Response, token: str = Depends(bearer)):
        response.headers.update(NO_STORE)
        return serialize_session(security.current(token, "tcg_access"))

    @app.get("/oauth2/admin-session")
    def admin_session(response: Response, token: str = Depends(bearer)):
        user = security.current(token)
        if security.tokens.read(token).get("dev_session") is not None:
            raise HTTPException(403, "Sign in with a second factor to administer TCG Manager.")
        principal = require_permission(principal_for(user), "admin:tcg:read")
        response.headers.update(NO_STORE)
        return {"id": user.id, "principal_type": "user", "can_refresh": has_permission(principal, "admin:tcg:refresh")}
