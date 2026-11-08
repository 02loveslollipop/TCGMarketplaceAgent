from datetime import timedelta
import time
import pytest
import jwt
import pyotp
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from shared.contracts import utcnow
from services.auth.security import AuthenticationError, Security, Tokens, hash_password, verify_password


@pytest.fixture
def security(repo):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    return Security(repo, Tokens(public, private), Fernet.generate_key())


def test_passwords_and_purpose_bound_tokens(repo, security):
    hashed = hash_password("a-good-test-password")
    assert hashed.startswith("$argon2id$") and verify_password(hashed, "a-good-test-password")
    assert not verify_password(hashed, "wrong")
    assert not verify_password(None, "a-good-test-password")
    user = repo.add_user("test", hashed)
    result = security.login("test", "a-good-test-password")
    assert result["requires_enrollment"] and "access_token" not in result
    assert security.current(result["enrollment_token"],"enrollment").id == user.id
    with pytest.raises(AuthenticationError):
        security.tokens.read(result["enrollment_token"], "second_factor")
    repo.update_user(user.id, active=False)
    with pytest.raises(AuthenticationError):
        security.current(result["enrollment_token"],"enrollment")


def test_expired_and_wrong_issuer_tokens(repo, security):
    user = repo.add_user("test", hash_password("test-password-long"))
    token = security.tokens.issue(user)
    payload = jwt.decode(token, options={"verify_signature":False})
    for changes in ({"exp":int((utcnow()-timedelta(seconds=1)).timestamp())}, {"iss":"other"}, {"aud":"other"}):
        malformed = jwt.encode(payload | changes, security.tokens.private_key, algorithm="RS256")
        with pytest.raises(AuthenticationError):
            security.tokens.read(malformed)


def test_totp_enrollment_challenge_and_replay(repo, security):
    user = repo.add_user("test", hash_password("test-password-long"))
    enrollment = security.enroll_totp(user)
    assert enrollment["uri"].startswith("otpauth://")
    assert repo.user(user_id=user.id).totp_pending != enrollment["secret"]
    security.confirm_totp(repo.user(user_id=user.id), pyotp.TOTP(enrollment["secret"]).now())
    result = security.login("test", "test-password-long")
    assert result["requires_2fa"] and "access_token" not in result
    with pytest.raises(AuthenticationError):
        security.current(result["challenge_token"])
    future_code = pyotp.TOTP(enrollment["secret"]).at((int(time.time())//30 + 1)*30)
    assert security.second_factor(result["challenge_token"], future_code)["access_token"]
    with pytest.raises(AuthenticationError):
        security.second_factor(result["challenge_token"], future_code)


def test_totp_wrong_codes_consume_attempt_budget(repo, security):
    user = repo.add_user("test", hash_password("test-password-long"))
    enrollment = security.enroll_totp(user)
    security.confirm_totp(repo.user(user_id=user.id), pyotp.TOTP(enrollment["secret"]).now())
    token = security.login("test", "test-password-long")["challenge_token"]
    for _ in range(6):
        with pytest.raises(AuthenticationError):
            security.second_factor(token, "wrong")


def test_local_password_only_requires_active_password_and_revokes_on_mode_change(repo, security):
    from fastapi.testclient import TestClient
    from services.auth.app import create_app
    password = "test-password-long"
    user = repo.add_user("local-user", hash_password(password))
    secret = security.enroll_totp(user)["secret"]
    security.confirm_totp(repo.user(user_id=user.id), pyotp.TOTP(secret).now())
    enrolled = repo.user(user_id=user.id).totp_secret
    local = Security(repo, security.tokens, Fernet.generate_key(), local_password_only=True)
    client = TestClient(create_app(repo, local))
    assert client.post("/token", data={"username":"local-user", "password":"wrong"}).status_code == 401
    response = client.post("/token", data={"username":"local-user", "password":password})
    assert response.status_code == 200 and "challenge_token" not in response.json()
    token = response.json()["access_token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert client.get("/session", headers=auth).json()["totp_enrolled"] is True
    assert repo.user(user_id=user.id).totp_secret == enrolled
    secure_client = TestClient(create_app(repo, security))
    assert secure_client.get("/session", headers=auth).status_code == 401
    assert "challenge_token" in secure_client.post("/token", data={"username":"local-user", "password":password}).json()
    restarted_local = Security(repo, security.tokens, Fernet.generate_key(), local_password_only=True)
    assert TestClient(create_app(repo, restarted_local)).get("/session", headers=auth).status_code == 401
    repo.update_user(user.id, active=False)
    assert client.get("/session", headers=auth).status_code == 401
    assert client.post("/token", data={"username":"local-user", "password":password}).status_code == 401


def test_local_password_only_allows_unenrolled_accounts_and_preserves_rate_limit(repo, security):
    from fastapi.testclient import TestClient
    from services.auth.app import create_app
    user = repo.add_user("unenrolled", hash_password("test-password-long"))
    local = Security(repo, security.tokens, Fernet.generate_key(), local_password_only=True)
    client = TestClient(create_app(repo, local))
    for _ in range(10):
        response = client.post("/token", data={"username":"unenrolled", "password":"test-password-long"})
        assert response.status_code == 200
    token = response.json()["access_token"]
    session = client.get("/session", headers={"Authorization":f"Bearer {token}"})
    assert session.status_code == 200 and not session.json()["totp_enrolled"] and not session.json()["webauthn_enrolled"]
    assert client.post("/token", data={"username":"unenrolled", "password":"test-password-long"}).status_code == 429
    assert not repo.user(user_id=user.id).totp_secret
    assert not repo.webauthn_credentials(user.id)
