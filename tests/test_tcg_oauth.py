import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit

import psycopg
import pyotp
import pytest
from fastapi.testclient import TestClient

from services.auth.app import create_app
from services.auth.security import hash_password
from services.auth.tcg_oauth import digest
from services.auth.webauthn import WebAuthn
from tests.test_security import security
from tests.test_webauthn import Authenticator, enroll


@pytest.fixture
def oauth_client(repo, security, monkeypatch):
    url = os.getenv("TCG_OAUTH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires a migrated tcg_manager_oauth_test fixture database.")
    with psycopg.connect(url) as db:
        assert db.execute("SELECT current_database()").fetchone()[0] == "tcg_manager_oauth_test"
        db.execute("DELETE FROM tcg_manager.oauth_grants")
    uri = "https://collection.example/oauth/callback"
    monkeypatch.setenv("TCG_OAUTH_DATABASE_URL", url)
    monkeypatch.setenv("TCG_OAUTH_PORTAL_URL", "https://portal.example/")
    monkeypatch.setenv("TCG_OAUTH_CLIENTS", json.dumps({"tcg-web": [uri]}))
    user = repo.add_user("owner", hash_password("fixture-account-password"))
    secret = pyotp.random_base32()
    repo.update_user(user.id, totp_secret=security.cipher.encrypt(secret.encode()).decode())
    verifier = "a" * 44
    with TestClient(create_app(repo, security)) as browser:
        yield browser, user, secret, verifier, uri


def test_tcg_oauth_with_real_totp_and_atomic_pkce(oauth_client):
    browser, user, secret, verifier, uri = oauth_client
    query = {
        "client_id": "tcg-web", "response_type": "code", "redirect_uri": uri,
        "state": "example-correlation-state-random", "code_challenge_method": "S256",
        "code_challenge": base64.urlsafe_b64encode(digest(verifier)).decode().rstrip("="),
    }
    authorize = "/oauth2/authorize"
    assert browser.get(authorize, params={**query, "redirect_uri": uri + "/"}, follow_redirects=False).status_code == 400
    response = browser.get(authorize, params=query, follow_redirects=False)
    assert response.status_code == 303
    assert urlsplit(response.headers["Location"]).hostname == "portal.example"

    password = browser.post("/token", data={"username": "owner", "password": "fixture-account-password"}).json()
    assert "access_token" not in password
    challenge = {"Authorization": f"Bearer {password['challenge_token']}"}
    assert browser.post(authorize, json=query, headers=challenge).status_code == 401
    login = browser.post("/totp/challenge", json={
        "challenge_token": password["challenge_token"], "code": pyotp.TOTP(secret).now(),
    })
    assert login.status_code == 200
    portal = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert browser.get("/session", headers=portal).status_code == 200
    assert browser.get("/oauth2/session", headers=portal).status_code == 401
    assert browser.get("/oauth2/admin-session", headers=portal).status_code == 403
    granted = browser.post(authorize, json=query, headers=portal)
    assert granted.status_code == 200
    grant = parse_qs(urlsplit(granted.json()["redirect_uri"]).query)
    assert grant["state"] == [query["state"]]
    form = {
        "grant_type": "authorization_code", "code": grant["code"][0], "code_verifier": verifier,
        "client_id": query["client_id"], "redirect_uri": uri,
    }
    token_url = "/oauth2/token"
    assert browser.post(token_url, data={**form, "code_verifier": "b" * 44}).json() == {"error": "invalid_grant"}
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: browser.post(token_url, data=form), range(2)))
    assert sorted(response.status_code for response in results) == [200, 400]
    access = next(response for response in results if response.is_success).json()["access_token"]
    auth = {"Authorization": f"Bearer {access}"}
    assert browser.get("/oauth2/session", headers=auth).json()["id"] == user.id
    assert browser.get("/session", headers=auth).status_code == 401
    assert browser.post("/logout", headers=portal).status_code == 200
    assert browser.get("/oauth2/session", headers=auth).status_code == 401


def test_tcg_oauth_after_signed_security_key_assertion(oauth_client, repo, security):
    browser, user, _secret, verifier, redirect = oauth_client
    key = Authenticator()
    enroll(repo, WebAuthn(security), user, key, name="Fixture security key")
    repo.update_user(user.id, role="admin")
    login = browser.post("/token", data={"username": "owner", "password": "fixture-account-password"}).json()
    assert "webauthn" in login["methods"] and "access_token" not in login
    challenge = {"challenge_token": login["challenge_token"]}
    request = browser.post("/webauthn/authentication/options", json=challenge).json()
    authenticated = browser.post("/webauthn/authentication/verify", json={
        **challenge, "challenge_id": request["challenge_id"], "credential": key.assert_login(request["options"]),
    })
    assert authenticated.status_code == 200
    portal = {"Authorization": f"Bearer {authenticated.json()['access_token']}"}
    assert browser.get("/session", headers=portal).json()["webauthn_enrolled"]
    assert browser.get("/oauth2/admin-session", headers=portal).json()["can_refresh"] is True
    grant = browser.post("/oauth2/authorize", headers=portal, json={
        "response_type": "code", "client_id": "tcg-web", "redirect_uri": redirect,
        "state": "fixture-key-state-correlation", "code_challenge_method": "S256",
        "code_challenge": base64.urlsafe_b64encode(digest(verifier)).decode().rstrip("="),
    })
    assert grant.status_code == 200
    code = parse_qs(urlsplit(grant.json()["redirect_uri"]).query)["code"][0]
    token = browser.post("/oauth2/token", data={
        "grant_type": "authorization_code", "client_id": "tcg-web", "redirect_uri": redirect,
        "code_verifier": verifier, "code": code,
    })
    assert token.status_code == 200
    scoped = {"Authorization": f"Bearer {token.json()['access_token']}"}
    assert browser.get("/oauth2/session", headers=scoped).json()["id"] == user.id
