"""Real ES256/COSE/CBOR fixtures exercise library verification, not mock verdicts."""
from datetime import timedelta
import hashlib
import json
import secrets
import time
from uuid import UUID

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
import pyotp
import pytest
from sqlalchemy import update
from webauthn.helpers import bytes_to_base64url

from shared.contracts import utcnow
from shared.db import Challenge, WebAuthnChallenge
from services.auth.app import create_app
from services.auth.security import AuthenticationError, hash_password
from services.auth.webauthn import WebAuthn
from tests.test_security import security


class Authenticator:
    def __init__(self, synced=False):
        self.key=ec.generate_private_key(ec.SECP256R1())
        self.credential_id=secrets.token_bytes(32)
        self.synced=synced

    def client(self, kind, challenge, origin, cross_origin=False):
        return json.dumps({"type":kind,"challenge":challenge,"origin":origin,"crossOrigin":cross_origin},separators=(",",":")).encode()

    def auth_data(self, rp, counter, flags):
        return hashlib.sha256(rp.encode()).digest()+bytes([flags | (0x18 if self.synced else 0)])+counter.to_bytes(4,"big")

    def register(self, options, *, origin="http://localhost:8080", rp="localhost", flags=0x45, counter=0, bad_signature=False, cross_origin=False):
        public=self.key.public_key().public_numbers()
        cose=cbor2.dumps({1:2,3:-7,-1:1,-2:public.x.to_bytes(32,"big"),-3:public.y.to_bytes(32,"big")})
        data=self.auth_data(rp,counter,flags)+bytes(16)+len(self.credential_id).to_bytes(2,"big")+self.credential_id+cose
        client=self.client("webauthn.create",options["challenge"],origin,cross_origin)
        signature=self.key.sign(data+hashlib.sha256(client).digest(),ec.ECDSA(hashes.SHA256()))
        if bad_signature:
            signature=signature[:-1]+bytes([signature[-1]^1])
        attestation=cbor2.dumps({"fmt":"packed","authData":data,"attStmt":{"alg":-7,"sig":signature}})
        return {"id":bytes_to_base64url(self.credential_id),"rawId":bytes_to_base64url(self.credential_id),"type":"public-key",
                "response":{"clientDataJSON":bytes_to_base64url(client),"attestationObject":bytes_to_base64url(attestation),"transports":["usb","hybrid"]},"clientExtensionResults":{}}

    def assert_login(self, options, *, origin="http://localhost:8080", rp="localhost", flags=0x05, counter=1, handle=None, bad_signature=False):
        data=self.auth_data(rp,counter,flags)
        client=self.client("webauthn.get",options["challenge"],origin)
        signature=self.key.sign(data+hashlib.sha256(client).digest(),ec.ECDSA(hashes.SHA256()))
        if bad_signature:
            signature=signature[:-1]+bytes([signature[-1]^1])
        return {"id":bytes_to_base64url(self.credential_id),"rawId":bytes_to_base64url(self.credential_id),"type":"public-key",
                "response":{"clientDataJSON":bytes_to_base64url(client),"authenticatorData":bytes_to_base64url(data),"signature":bytes_to_base64url(signature),"userHandle":handle},"clientExtensionResults":{}}


@pytest.fixture
def setup(repo, security):
    user=repo.add_user("webauthn-user",hash_password("test-password-long"))
    return user,WebAuthn(security),Authenticator()


def enroll(repo, service, user, authenticator, name="Test authenticator"):
    ceremony=service.begin_registration(repo.user(user_id=user.id),name)
    assert service.finish_registration(repo.user(user_id=user.id),ceremony["challenge_id"],authenticator.register(ceremony["options"]))["enrolled"]
    return repo.user(user_id=user.id)


def begin_login(service, user):
    login=service.security.login(user.username,"test-password-long")
    assert "access_token" not in login and login["requires_2fa"]
    return login["challenge_token"],service.begin_authentication(login["challenge_token"])


def test_real_registration_authentication_multiple_names_and_no_downgrade(repo, setup):
    user,service,key=setup
    ceremony=service.begin_registration(user,"Physical key")
    options=ceremony["options"]
    assert options["rp"]["id"]=="localhost" and options["authenticatorSelection"]["userVerification"]=="required"
    assert "authenticatorAttachment" not in options["authenticatorSelection"]
    assert options["user"]["id"]==bytes_to_base64url(UUID(user.id).bytes)
    proof=key.register(options)
    assert service.finish_registration(user,ceremony["challenge_id"],proof)["sign_in_again"]
    with pytest.raises(AuthenticationError,match="consumed"):
        service.finish_registration(user,ceremony["challenge_id"],proof)
    user=repo.user(user_id=user.id)
    next_options=service.begin_registration(user,"Phone passkey")
    assert next_options["options"]["user"]["id"]==options["user"]["id"]
    assert next_options["options"]["excludeCredentials"][0]["id"]==proof["id"]
    phone=Authenticator(synced=True)
    service.finish_registration(user,next_options["challenge_id"],phone.register(next_options["options"]))
    user=repo.user(user_id=user.id)
    credentials=repo.webauthn_credentials(user.id)
    assert [row.name for row in credentials]==["Physical key","Phone passkey"]
    assert credentials[0].transports==["usb","hybrid"]
    token,request=begin_login(service,user)
    assert request["options"]["userVerification"]=="required"
    result=service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"],handle=bytes_to_base64url(UUID(user.id).bytes)))
    assert service.security.current(result["access_token"]).id==user.id
    with pytest.raises(AuthenticationError,match="consumed"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"]))
    assert service.remove(user,credentials[1].id)["removed"]
    with pytest.raises(ValueError,match="last authenticator"):
        service.remove(repo.user(user_id=user.id),credentials[0].id)


@pytest.mark.parametrize("changes",[{"origin":"https://evil.example"},{"rp":"evil.example"},{"flags":0x41},{"flags":0x44},{"bad_signature":True},{"cross_origin":True}])
def test_registration_rejects_wrong_origin_rp_presence_uv_signature_and_consumes(repo, setup, changes):
    user,service,key=setup
    request=service.begin_registration(user,"Key")
    with pytest.raises(AuthenticationError,match="could not be verified"):
        service.finish_registration(user,request["challenge_id"],key.register(request["options"],**changes))
    with pytest.raises(AuthenticationError,match="consumed"):
        service.finish_registration(user,request["challenge_id"],key.register(request["options"]))
    assert not repo.webauthn_credentials(user.id)


@pytest.mark.parametrize("changes",[{"origin":"https://evil.example"},{"rp":"evil.example"},{"flags":0x01},{"flags":0x04},{"bad_signature":True},{"handle":bytes_to_base64url(secrets.token_bytes(16))}])
def test_assertion_rejects_wrong_origin_rp_presence_uv_signature_handle(repo,setup,changes):
    user,service,key=setup
    user=enroll(repo,service,user,key)
    token,request=begin_login(service,user)
    with pytest.raises(AuthenticationError,match="could not be verified"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"],**changes))
    with pytest.raises(AuthenticationError,match="consumed"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"]))
    retry=service.begin_authentication(token)
    assert service.finish_authentication(token,retry["challenge_id"],key.assert_login(retry["options"]))["access_token"]


def test_expired_challenges_cancel_and_single_atomic_claim(repo,setup):
    user,service,key=setup
    expired=service.begin_registration(user,"Expired")
    with repo.transaction() as session:
        session.execute(update(WebAuthnChallenge).where(WebAuthnChallenge.id==expired["challenge_id"]).values(expires_at=utcnow()-timedelta(seconds=1)))
    with pytest.raises(AuthenticationError,match="expired"):
        service.finish_registration(user,expired["challenge_id"],key.register(expired["options"]))
    cancelled=service.begin_registration(user,"Cancelled")
    service.cancel(user,cancelled["challenge_id"])
    with pytest.raises(AuthenticationError,match="consumed"):
        service.finish_registration(user,cancelled["challenge_id"],key.register(cancelled["options"]))
    claimed=service.begin_registration(user,"Atomic claim")
    assert service.claim(claimed["challenge_id"],user,"registration").consumed
    with pytest.raises(AuthenticationError,match="consumed"):
        service.claim(claimed["challenge_id"],user,"registration")


def test_credential_owner_and_password_challenge_binding(repo,setup):
    user,service,key=setup
    user=enroll(repo,service,user,key)
    other=repo.add_user("other",hash_password("test-password-long"))
    other_key=Authenticator();other=enroll(repo,service,other,other_key)
    token,request=begin_login(service,user)
    with pytest.raises(AuthenticationError,match="belong"):
        service.finish_authentication(token,request["challenge_id"],other_key.assert_login(request["options"]))
    token,request=begin_login(service,user)
    other_token,_=begin_login(service,user)
    with pytest.raises(AuthenticationError,match="another password challenge"):
        service.finish_authentication(other_token,request["challenge_id"],key.assert_login(request["options"]))
    fresh=service.begin_registration(user,"Owner binding")
    with pytest.raises(AuthenticationError,match="changed or consumed"):
        service.finish_registration(other,fresh["challenge_id"],Authenticator().register(fresh["options"]))


def test_counters_advance_and_zero_counter_synced_passkeys_work(repo,setup):
    user,service,key=setup
    user=enroll(repo,service,user,key)
    token,request=begin_login(service,user)
    service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"],counter=5))
    assert repo.webauthn_credentials(user.id)[0].sign_count==5
    token,request=begin_login(service,user)
    with pytest.raises(AuthenticationError,match="could not be verified"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"],counter=5))
    synced=Authenticator(synced=True);user=enroll(repo,service,user,synced,"Synced")
    for _ in range(2):
        token,request=begin_login(service,user)
        assert service.finish_authentication(token,request["challenge_id"],synced.assert_login(request["options"],counter=0))["access_token"]


def test_inactive_account_and_totp_alternative_preserved(repo,setup):
    user,service,key=setup
    user=enroll(repo,service,user,key)
    enrollment=service.security.enroll_totp(user)
    service.security.confirm_totp(repo.user(user_id=user.id),pyotp.TOTP(enrollment["secret"]).now())
    user=repo.user(user_id=user.id)
    login=service.security.login(user.username,"test-password-long")
    assert login["methods"]==["webauthn","totp"]
    code=pyotp.TOTP(enrollment["secret"]).at((int(time.time())//30+1)*30)
    assert service.security.second_factor(login["challenge_token"],code)["access_token"]
    with pytest.raises(AuthenticationError,match="consumed"):
        service.begin_authentication(login["challenge_token"])
    token,request=begin_login(service,user)
    repo.update_user(user.id,active=False)
    with pytest.raises(AuthenticationError,match="unavailable"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"]))


def test_api_requires_password_then_factor_and_exposes_only_own_metadata(repo,setup):
    user,service,key=setup
    client=TestClient(create_app(repo,service.security,service))
    token=service.security.login(user.username,"test-password-long")["enrollment_token"]
    headers={"Authorization":f"Bearer {token}"}
    assert client.post("/webauthn/registration/options",json={"name":"Key"}).status_code==401
    assert client.post("/webauthn/authentication/options",json={"challenge_token":token}).status_code==401
    assert client.post("/webauthn/registration/options",headers=headers,json={"name":"Illegal"}).status_code==401
    request=client.post("/onboarding/webauthn/registration/options",headers=headers,json={"name":"Physical key"}).json()
    response=client.post("/onboarding/webauthn/registration/verify",headers=headers,json={"challenge_id":request["challenge_id"],"credential":key.register(request["options"])})
    assert response.status_code==200
    assert client.get("/session",headers=headers).status_code==401
    login=client.post("/token",data={"username":user.username,"password":"test-password-long"}).json()
    assert "access_token" not in login and login["methods"]==["webauthn","recovery"]
    limited={"Authorization":f"Bearer {login['challenge_token']}"}
    assert client.get("/session",headers=limited).status_code==401
    assert client.post("/webauthn/registration/options",headers=limited,json={"name":"Illegal"}).status_code==401
    request=client.post("/webauthn/authentication/options",json={"challenge_token":login["challenge_token"]}).json()
    verified=client.post("/webauthn/authentication/verify",json={"challenge_token":login["challenge_token"],"challenge_id":request["challenge_id"],"credential":key.assert_login(request["options"])})
    assert verified.status_code==200
    headers={"Authorization":f"Bearer {verified.json()['access_token']}"}
    assert client.get("/session",headers=headers).json()["webauthn_enrolled"]
    credentials=client.get("/webauthn/credentials",headers=headers).json()
    assert credentials[0]["name"]=="Physical key" and "public_key" not in credentials[0]
    assert client.delete(f"/webauthn/credentials/{credentials[0]['id']}",headers=headers).status_code==409
    assert client.post("/webauthn/authentication/verify",json={"challenge_token":login["challenge_token"],"challenge_id":request["challenge_id"],"credential":key.assert_login(request["options"]) }).status_code==401


def test_untrusted_origin_configuration_is_rejected(setup):
    _,service,_=setup
    for rp,origin in (("localhost","http://evil.example"),("example.com","http://example.com"),("localhost","http://localhost:8080/path")):
        with pytest.raises(ValueError):
            WebAuthn(service.security,rp,origin)


def test_expired_authentication_and_password_challenges_rejected(repo,setup):
    user,service,key=setup
    user=enroll(repo,service,user,key)
    token,request=begin_login(service,user)
    with repo.transaction() as session:
        session.execute(update(WebAuthnChallenge).where(WebAuthnChallenge.id==request["challenge_id"]).values(expires_at=utcnow()-timedelta(seconds=1)))
    with pytest.raises(AuthenticationError,match="expired"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"]))
    token,request=begin_login(service,user)
    parent=service.security.tokens.read(token,"second_factor")["challenge_id"]
    with repo.transaction() as session:
        session.execute(update(Challenge).where(Challenge.id==parent).values(expires_at=utcnow()-timedelta(seconds=1)))
    with pytest.raises(AuthenticationError,match="expired"):
        service.finish_authentication(token,request["challenge_id"],key.assert_login(request["options"]))


def test_wrong_challenge_and_distinct_registration_authentication_purpose(repo,setup):
    user,service,key=setup
    first=service.begin_registration(user,"First")
    second=service.begin_registration(user,"Second")
    with pytest.raises(AuthenticationError,match="could not be verified"):
        service.finish_registration(user,first["challenge_id"],key.register(second["options"]))
    with pytest.raises(AuthenticationError,match="consumed"):
        service.claim(second["challenge_id"],user,"authentication")
    assert service.finish_registration(user,second["challenge_id"],key.register(second["options"]))["enrolled"]


def test_shared_rp_accepts_only_configured_frontend_origins(repo, setup):
    user, previous, key = setup
    rp = "tcg-marketplace.02labs.me"
    chat = "https://chat." + rp
    admin = "https://admin." + rp
    service = WebAuthn(previous.security, rp, chat + "," + admin)
    ceremony = service.begin_registration(user, "Shared key")
    service.finish_registration(user, ceremony["challenge_id"], key.register(ceremony["options"], origin=chat, rp=rp))
    user = repo.user(user_id=user.id)
    token, request = begin_login(service, user)
    result = service.finish_authentication(token, request["challenge_id"], key.assert_login(request["options"], origin=admin, rp=rp))
    assert service.security.current(result["access_token"]).id == user.id
    token, request = begin_login(service, user)
    with pytest.raises(AuthenticationError):
        service.finish_authentication(token, request["challenge_id"], key.assert_login(request["options"], origin="https://evil." + rp, rp=rp, counter=2))
    with pytest.raises(ValueError):
        WebAuthn(previous.security, rp, "https://evil" + rp)
