import json
import pytest
from fastapi import Depends, HTTPException
from fastapi.testclient import TestClient
from shared.api import Principal, bearer
from shared.contracts import Decision
from services.auth.app import create_app as auth_app
from services.admin.app import create_app as admin_app
from services.orchestrator.app import create_app as chat_app
from services.orchestrator.agent import DeckAgent
from services.auth.security import hash_password
from services.orchestrator.models import GuardedModel, ModelUnavailable
from tests.test_agent import FakePlanner, FakeSuppliers
from tests.test_security import security


async def current(token: str=Depends(bearer)):
    if token not in {"owner","other","admin"}:
        raise HTTPException(401,"Invalid test token")
    return Principal(token,token,"admin" if token=="admin" else "user",token)


async def verified(provider,api_id):
    return api_id == "fixture"


@pytest.fixture
def client(repo):
    repo.save_model("fixture",label="Fixture",provider="openai",api_id="fixture",enabled=True)
    app = chat_app(repo,current,lambda policy:DeckAgent(repo,FakePlanner(),FakeSuppliers()),verified)
    return TestClient(app)


def headers(user="owner"):
    return {"Authorization":f"Bearer {user}"}


def test_sse_cards_results_and_persistent_history(client,repo):
    response = client.post("/executions",headers=headers(),json={"text":"exact Test","model_id":"fixture"})
    assert response.status_code==200 and response.headers["content-type"].startswith("text/event-stream")
    assert "event: cards" in response.text and "event: result" in response.text
    assert '"product_subtotal": "1.25"' in response.text
    conversation = client.get("/conversations",headers=headers()).json()[0]
    history=client.get(f"/conversations/{conversation['id']}",headers=headers()).json()
    assert history[0]['content']['text']=='exact Test' and history[-1]['content']['type']=='result'
    tools=[row['content']['data'] for row in history if row['content'].get('type')=='tool']
    assert len(tools)==5 and all(tool['status']=='complete' for tool in tools)
    assert {tool['name'] for tool in tools} == {'current_legality','baseline_prices','check_supplier_stock'}
    assert client.get(f"/conversations/{conversation['id']}",headers=headers("other")).status_code==404


def test_token_admin_model_policy_and_execution_ownership(client,repo):
    assert client.get("/models").status_code==401
    assert client.post("/internal/models/verify",headers=headers(),json={"provider":"openai","api_id":"fixture"}).status_code==403
    assert client.post("/executions",headers=headers(),json={"text":"x","model_id":"disabled"}).status_code==403
    response = client.post("/executions",headers=headers(),json={"text":"Make M Gardevoir EX deck","model_id":"fixture"})
    data = json.loads(response.text.split("data: ")[1].split("\n")[0])
    path = f"/executions/{data['id']}/resume"
    assert client.post(path,headers=headers("other"),json={"action":"clarify","text":"Standard"}).status_code==404
    assert client.post(path,headers=headers(),json={"action":"keep_missing","approved":True}).status_code==422
    assert client.post(path,headers=headers(),json={"action":"clarify","text":"Fixture standard"}).status_code==200
    assert client.post(path,headers=headers(),json={"action":"clarify","text":"again"}).status_code==409


def test_missing_consent_is_validated_before_resume(repo):
    repo.save_model("fixture",label="Fixture",provider="openai",api_id="fixture",enabled=True)
    client = TestClient(chat_app(repo,current,lambda policy:DeckAgent(repo,FakePlanner(),FakeSuppliers(False)),verified))
    response = client.post("/executions",headers=headers(),json={"text":"exact","model_id":"fixture"})
    data = json.loads(response.text.split("data: ")[1].split("\n")[0])
    path = f"/executions/{data['id']}/resume"
    assert client.post(path,headers=headers(),json={"action":"keep_missing","approved":False}).status_code==422
    approved = client.post(path,headers=headers(),json={"action":"keep_missing","approved":True})
    assert "event: result" in approved.text


def test_auth_login_admin_account_and_state_enforcement(repo,security):
    user=repo.add_user("one",hash_password("long-user-password"))
    import pyotp
    secret=pyotp.random_base32()
    repo.update_user(user.id,totp_secret=security.cipher.encrypt(secret.encode()).decode())
    client = TestClient(auth_app(repo,security))
    response = client.post("/token",data={"username":"one","password":"long-user-password"})
    assert response.status_code==200
    token = client.post('/totp/challenge',json={'challenge_token':response.json()['challenge_token'],'code':pyotp.TOTP(secret).now()}).json()["access_token"]
    assert client.get("/session",headers={"Authorization":f"Bearer {token}"}).status_code==200
    assert client.post("/accounts",headers={"Authorization":f"Bearer {token}"},json={"username":"two","password":"long-user-password"}).status_code==403
    client.post("/logout",headers={"Authorization":f"Bearer {token}"})
    assert client.get("/session",headers={"Authorization":f"Bearer {token}"}).status_code==401


def test_admin_models_authorization_and_unverified_model(repo):
    client = TestClient(admin_app(repo,current))
    assert client.get("/models",headers=headers()).status_code==403
    response = client.put("/models/test",headers=headers("admin"),json={"label":"Test","provider":"openai","api_id":"fixture","enabled":False})
    assert response.status_code==200 and not response.json()["enabled"]
    assert client.get("/models",headers=headers("admin")).json()[0]["api_id"]=="fixture"


async def test_model_disable_between_tool_rounds_prevents_next_invocation(repo):
    class Runnable:
        async def ainvoke(self,messages):
            return "fixture answer"
    policy=repo.save_model("fixture",label="Fixture",provider="openai",api_id="fixture",enabled=True)
    guarded=GuardedModel(Runnable(),repo,policy)
    assert await guarded.ainvoke([])=="fixture answer"
    repo.save_model("fixture",label="Fixture",provider="openai",api_id="fixture",enabled=False)
    with pytest.raises(ModelUnavailable,match="disabled"):
        await guarded.ainvoke([])


async def test_remote_introspection_rejects_development_session_when_mode_disabled(repo, security, monkeypatch):
    from cryptography.fernet import Fernet
    from services.auth.security import Security
    from shared.api import remote_auth
    user = repo.add_user("local-api", hash_password("long-user-password"))
    dev = Security(repo, security.tokens, Fernet.generate_key(), local_password_only=True)
    token = dev.login("local-api", "long-user-password")["access_token"]
    enabled_client = TestClient(auth_app(repo, dev))
    disabled_client = TestClient(auth_app(repo, security))
    selected = [enabled_client]

    class FakeAsyncClient:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def get(self, url, headers): return selected[0].get("/session", headers=headers)

    monkeypatch.setattr("shared.api.httpx.AsyncClient", FakeAsyncClient)
    authenticate = remote_auth("http://auth")
    assert (await authenticate(token=token)).id == user.id
    selected[0] = disabled_client
    with pytest.raises(HTTPException) as error:
        await authenticate(token=token)
    assert error.value.status_code == 401
