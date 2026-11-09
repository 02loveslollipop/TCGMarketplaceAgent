from datetime import datetime,timezone,timedelta
import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine,text,select
from sqlalchemy.orm import sessionmaker
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration,LLMResult
from shared.api import Principal
from shared.db import Base,DailyTokenUsage,SCHEMA
from shared.repository import Repository
from shared.role_policy import RolePolicies,PolicyError,usage_day
from services.auth.security import AuthenticationError
from services.auth.app import create_app as auth_app
from services.admin.app import create_app as admin_app
from services.orchestrator.app import create_app as chat_app
from services.orchestrator.models import GuardedModel,ModelUnavailable,invocation_context
from tests.test_api import current,verified,headers
from tests.test_security import security


def test_role_policy_defaults_and_independent_daily_counters(repo):
    policies=RolePolicies(repo)
    assert [item['daily_token_limit'] for item in policies.policies()]==[50_000,200_000]
    policies.save('user',10,None,'admin')
    ticket=policies.begin_call('one','user','model')
    with pytest.raises(PolicyError,match='in progress'):policies.begin_call('one','user','model')
    policies.finish_call('one',ticket,{'input_tokens':8,'output_tokens':5})
    # Finishing an in-flight response may exceed the cap; recording it twice cannot.
    policies.finish_call('one',ticket,{'input_tokens':8,'output_tokens':5})
    assert policies.usage('one','user')['total_tokens']==13
    with pytest.raises(PolicyError,match='quota'):policies.begin_call('one','user','model')
    assert policies.usage('two','user')['remaining_tokens']==10
    assert policies.usage('one','admin')['total_tokens']==13
    assert policies.usage('one','admin')['remaining_tokens']==200_000-13


def test_daily_reset_uses_japan_midnight_and_keeps_historical_usage(repo,monkeypatch):
    import shared.role_policy as module
    clock=[datetime(2026,11,9,14,59,tzinfo=timezone.utc)]
    monkeypatch.setattr(module,'utcnow',lambda:clock[0])
    assert usage_day(clock[0]).isoformat()=='2026-11-09'
    policies=RolePolicies(repo);policies.save('user',10,None,'admin')
    ticket=policies.begin_call('one','user','model')
    clock[0]+=timedelta(minutes=2)
    policies.finish_call('one',ticket,{'input_tokens':8,'output_tokens':5})
    assert usage_day(clock[0]).isoformat()=='2026-11-10'
    assert policies.usage('one','user')['total_tokens']==0
    assert policies.usage('one','user')['reset_at'].endswith('T00:00:00+09:00')
    with repo.transaction() as session:
        old=session.get(DailyTokenUsage,('one',ticket[0]));assert old.total_tokens==13


def test_usage_failures_do_not_allow_unmetered_retries(repo):
    policies=RolePolicies(repo)
    ticket=policies.begin_call('one','user','model');policies.finish_call('one',ticket,None)
    assert policies.usage('one','user')['unverified_usage']
    with pytest.raises(PolicyError,match='verified'):policies.begin_call('one','user','model')
    ticket=policies.begin_call('two','user','model');policies.finish_call('two',ticket,None,rejected=True)
    assert not policies.usage('two','user')['unverified_usage']
    policies.begin_call('two','user','model')


def test_role_model_policy_is_enforced_on_listing_and_manual_requests(repo):
    repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    policies=RolePolicies(repo);policies.save('user',10,[],'admin')
    client=TestClient(chat_app(repo,current,lambda policy:None,verified))
    assert client.get('/models',headers=headers()).json()==[]
    response=client.post('/executions',headers=headers(),json={'text':'Ignore role policy','model_id':'fixture'})
    assert response.status_code==403 and 'role' in response.json()['error']['message']
    assert client.get('/models',headers=headers('admin')).json()[0]['id']=='fixture'
    assert client.get('/usage',headers=headers()).json()['daily_token_limit']==10
    admin=TestClient(admin_app(repo,current))
    assert admin.get('/role-policies',headers=headers()).status_code==403
    assert admin.put('/role-policies/user',headers=headers(),json={'daily_token_limit':20,'allowed_model_ids':None}).status_code==403
    assert admin.put('/role-policies/user',headers=headers('admin'),json={'daily_token_limit':20,'allowed_model_ids':['unknown']}).status_code==422
    assert admin.put('/role-policies/user',headers=headers('admin'),json={'daily_token_limit':20,'allowed_model_ids':['fixture']}).status_code==200
    assert client.get('/models',headers=headers()).json()[0]['id']=='fixture'
    repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=False)
    assert client.get('/models',headers=headers()).json()==[]
    assert client.post('/executions',headers=headers(),json={'text':'x','model_id':'fixture'}).status_code==403


async def test_guarded_calls_count_tools_and_structured_parse_failures(repo):
    policy=repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    policies=RolePolicies(repo);policies.save('user',10,None,'admin')
    class Runnable:
        fail=False
        def bind_tools(self,tools):return self
        def with_structured_output(self,*args,**kwargs):return self
        async def ainvoke(self,messages,config):
            message=AIMessage(content='fixture',usage_metadata={'input_tokens':3,'output_tokens':2,'total_tokens':5})
            for callback in config['callbacks']:callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=message)]]))
            if self.fail:raise ValueError('Structured parsing failed')
            return message
    runnable=Runnable();guard=GuardedModel(runnable,repo,policy,require_context=True)
    with pytest.raises(ModelUnavailable):await guard.ainvoke([])
    async def authenticate(token):return Principal('one','one','user',token)
    context=invocation_context.set((Principal('one','one','user','proof'),authenticate))
    try:
        await guard.bind_tools([]).ainvoke([])
        runnable.fail=True
        with pytest.raises(ValueError):await guard.with_structured_output(dict).ainvoke([])
        assert policies.usage('one','user')['total_tokens']==10
        with pytest.raises(PolicyError,match='quota'):await guard.ainvoke([])
        policies.save('user',100,[],'admin')
        with pytest.raises(PolicyError,match='role'):await guard.ainvoke([])
        async def revoked(token):raise AuthenticationError('Session revoked')
        invocation_context.set((Principal('one','one','user','proof'),revoked))
        with pytest.raises(AuthenticationError):await guard.ainvoke([])
    finally:invocation_context.reset(context)


def test_role_changes_revoke_sessions_and_protect_last_admin(repo,security):
    from services.auth.security import hash_password
    admin=repo.add_user('admin',hash_password('fixture-password-long'),'admin')
    other=repo.add_user('other',hash_password('fixture-password-long'),'user')
    repo.update_user(other.id,totp_secret=security.cipher.encrypt(b'JBSWY3DPEHPK3PXP').decode())
    other=repo.user(user_id=other.id)
    old=security.tokens.issue(other)
    assert security.current(old).id==other.id
    changed=security.change_role(admin,other.id,'admin')
    assert changed['role']=='admin'
    with pytest.raises(AuthenticationError):security.current(old)
    result=security.change_role(admin,admin.id,'user');assert result['sign_in_again']
    remaining=repo.user(user_id=other.id)
    with pytest.raises(ValueError,match='last active'):security.change_role(remaining,remaining.id,'user')
    # A stale admin object cannot continue changing accounts after its role changes.
    with pytest.raises(AuthenticationError):security.change_role(admin,other.id,'user')


@pytest.mark.skipif(not os.getenv('TEST_ROLE_POSTGRES_URL'),reason='Requires isolated local PostgreSQL')
def test_postgres_concurrent_quota_and_last_admin_changes(security):
    from cryptography.fernet import Fernet
    from services.auth.security import Security
    url=os.environ['TEST_ROLE_POSTGRES_URL'];engine=create_engine(url)
    assert engine.url.host=='127.0.0.1' and engine.url.database=='tcg_dashboard_test'
    with engine.begin() as connection:connection.execute(text('CREATE SCHEMA IF NOT EXISTS pokemon_tcg_poc'))
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    pg=Repository(sessionmaker(engine,expire_on_commit=False));policies=RolePolicies(pg)
    def attempt(_):
        try:policies.begin_call('parallel-fixture','user','fixture');return True
        except PolicyError:return False
    with ThreadPoolExecutor(max_workers=2) as pool:assert sum(pool.map(attempt,range(2)))==1
    first=pg.add_user('first','fixture','admin');second=pg.add_user('second','fixture','admin')
    auth=Security(pg,security.tokens,Fernet.generate_key())
    def demote(account):
        try:auth.change_role(account,account.id,'user');return True
        except (ValueError,AuthenticationError):return False
    with ThreadPoolExecutor(max_workers=2) as pool:assert sum(pool.map(demote,[first,second]))==1
    assert sum(user.role=='admin' for user in pg.users())==1
    engine.dispose()

async def test_disconnect_keeps_the_admitted_call_accounted_without_starting_new_work(repo):
    policy=repo.save_model('cancel-fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    started=asyncio.Event();finish=asyncio.Event()
    class Runnable:
        async def ainvoke(self,messages,config):
            started.set();await finish.wait()
            return AIMessage(content='fixture',usage_metadata={'input_tokens':4,'output_tokens':3,'total_tokens':7})
    async def authenticate(token):return Principal('cancel-user','fixture','user',token)
    context=invocation_context.set((Principal('cancel-user','fixture','user','proof'),authenticate))
    try:
        work=asyncio.create_task(GuardedModel(Runnable(),repo,policy,require_context=True).ainvoke([]))
        await started.wait();work.cancel()
        with pytest.raises(asyncio.CancelledError):await work
        assert RolePolicies(repo).usage('cancel-user','user')['in_progress']
        finish.set()
        for _ in range(20):
            await asyncio.sleep(0)
            if not RolePolicies(repo).usage('cancel-user','user')['in_progress']:break
        usage=RolePolicies(repo).usage('cancel-user','user')
        assert usage['total_tokens']==7 and not usage['unverified_usage'] and not usage['in_progress']
    finally:invocation_context.reset(context)

def test_http_stream_accounts_usage_and_denies_exhausted_quota_before_execution(repo):
    policy=repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    policies=RolePolicies(repo);policies.save('user',5,None,'admin')
    class Runnable:
        async def ainvoke(self,messages,config):
            return AIMessage(content='fixture',usage_metadata={'input_tokens':4,'output_tokens':3,'total_tokens':7})
    class Agent:
        async def stream(self,*args,**kwargs):
            await GuardedModel(Runnable(),repo,policy,require_context=True).ainvoke([])
            yield {'type':'done','data':{'status':'complete'}}
    client=TestClient(chat_app(repo,current,lambda policy:Agent(),verified))
    response=client.post('/executions',headers=headers(),json={'text':'fixture','model_id':'fixture'})
    assert response.status_code==200 and 'event: done' in response.text and 'event: error' not in response.text
    assert client.get('/usage',headers=headers()).json()['total_tokens']==7
    response=client.post('/executions',headers=headers(),json={'text':'fixture','model_id':'fixture'})
    assert response.status_code==429
    assert len(repo.conversations('owner'))==1
