"""IAM integration: inheritance, credential isolation, ownership and quota enforcement."""
from datetime import timedelta
import hashlib
import json
import pytest
from fastapi import Depends,HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from shared.api import bearer,require_permission,Principal
from shared.contracts import utcnow
from shared.db import IAMRole,APIToken,AuditLog,APIPrincipal
from shared.iam import RoleInput,InlinePolicy,IAMError,resolve_role,permitted,BUILTIN_ROLE_IDS,legacy_policy
from shared.role_policy import RolePolicies,PolicyError
from services.auth.iam import IAM,PrincipalInput,TokenInput
from services.auth.app import create_app as auth_app
from services.admin.app import create_app as admin_app
from services.orchestrator.app import create_app as chat_app
from tests.test_security import security
from tests.test_agent import FakePlanner,FakeSuppliers
from tests.test_api import verified
from services.orchestrator.agent import DeckAgent

@pytest.fixture
def iam_setup(repo,security):
    admin=repo.add_user('iam-admin','unused',role='admin');repo.update_user(admin.id,totp_secret='enrolled')
    admin=repo.user(user_id=admin.id)
    iam=IAM(repo);jwt=security.tokens.issue(admin)
    client=TestClient(auth_app(repo,security))
    return iam,admin,jwt,client


def make_role(iam,admin,name='Test role',parent=None,limit=1000,statements=None):
    return iam.save_role(admin,RoleInput(name=name,parent_id=parent,daily_token_limit=limit,
        policy=InlinePolicy(statements=statements if statements is not None else [{'effect':'Allow','actions':['agent:*'],'resources':['*']}])))


def make_identity(iam,admin,role,name='CI runner'):
    p=iam.save_principal(admin,PrincipalInput(name=name,role_id=role['id']))
    key=iam.create_token(admin,p['id'],TokenInput(name='CI key'))
    return p,key


def test_inheritance_default_deny_explicit_deny_and_quota_override(repo,iam_setup):
    iam,admin,_,_=iam_setup
    parent=make_role(iam,admin,'Parent',limit=10,statements=[{'effect':'Allow','actions':['agent:*'],'resources':['*']},
        {'effect':'Deny','actions':['agent:models:invoke'],'resources':['model:blocked*']}])
    child=make_role(iam,admin,'Child',parent['id'],None,[{'effect':'Allow','actions':['*'],'resources':['*']}])
    assert child['effective_daily_token_limit']==10
    with repo.transaction() as s:
        effective=resolve_role(s,child['id'])
    assert not permitted(effective['statements'],'agent:models:invoke','model:blocked-1')
    assert permitted(effective['statements'],'agent:models:invoke','model:allowed')
    assert not permitted(effective['statements'],'iam:roles:write',principal_type='api')
    child=iam.save_role(admin,RoleInput(name='Child',parent_id=parent['id'],daily_token_limit=100,policy=InlinePolicy(statements=[])),child['id'])
    assert child['effective_daily_token_limit']==100
    empty=make_role(iam,admin,'No permissions',statements=[],limit=None)
    assert empty['effective_daily_token_limit']==0
    assert not permitted(empty['effective_statements'],'agent:executions:create')


def test_cycles_rejected_and_assigned_roles_cannot_be_deleted(iam_setup):
    iam,admin,_,_=iam_setup
    parent=make_role(iam,admin,'Parent');child=make_role(iam,admin,'Child',parent['id'])
    with pytest.raises(IAMError,match='cycle'):
        iam.save_role(admin,RoleInput(name='Parent',parent_id=child['id']),parent['id'])
    with pytest.raises(IAMError,match='Reassign'):
        iam.delete_role(admin,parent['id'])
    make_identity(iam,admin,child)
    with pytest.raises(IAMError,match='Reassign'):iam.delete_role(admin,child['id'])


def test_secret_shown_once_hash_only_and_revocation_does_not_reset_identity(repo,iam_setup):
    iam,admin,jwt,client=iam_setup
    role=make_role(iam,admin,limit=10);principal,first=make_identity(iam,admin,role)
    second=iam.create_token(admin,principal['id'],TokenInput(name='Rotated key'))
    assert first['credential']!=second['credential']
    assert iam.authenticate(first['credential']).id==iam.authenticate(second['credential']).id==principal['id']
    with repo.transaction() as s:
        row=s.get(APIToken,first['metadata']['id'])
        assert row.secret_hash==hashlib.sha256(first['credential'].encode()).hexdigest()
        assert abs((row.expires_at.replace(tzinfo=utcnow().tzinfo)-utcnow()).total_seconds()-30*86400)<10
        audit=json.dumps([r.details for r in s.scalars(select(AuditLog))])
        assert first['credential'] not in audit and row.secret_hash not in audit
    listed=iam.tokens(principal['id'])
    assert 'credential' not in json.dumps(listed) and 'secret_hash' not in json.dumps(listed)
    policies=RolePolicies(repo);ticket=policies.begin_call(principal['id'],role['id'],'fixture')
    policies.finish_call(principal['id'],ticket,{'input_tokens':6,'output_tokens':5})
    with pytest.raises(PolicyError,match='quota'):
        policies.begin_call(iam.authenticate(second['credential']).id,role['id'],'fixture')
    another,_=make_identity(iam,admin,role,'Other runner')
    assert policies.usage(another['id'],role['id'])['remaining_tokens']==10
    iam.revoke_token(admin,principal['id'],first['metadata']['id'])
    with pytest.raises(IAMError):iam.authenticate(first['credential'])
    assert iam.authenticate(second['credential']).id==principal['id']
    client.post('/logout',headers={'Authorization':'Bearer '+jwt})
    assert iam.authenticate(second['credential']).id==principal['id']


def test_expired_disabled_and_malformed_credentials_are_rejected(repo,iam_setup):
    iam,admin,_,_=iam_setup;role=make_role(iam,admin);principal,key=make_identity(iam,admin,role)
    with pytest.raises(IAMError):iam.authenticate(key['credential']+'x')
    with repo.transaction() as s:s.get(APIToken,key['metadata']['id']).expires_at=utcnow()-timedelta(seconds=1)
    with pytest.raises(IAMError):iam.authenticate(key['credential'])
    fresh=iam.create_token(admin,principal['id'],TokenInput(name='Fresh'))
    iam.save_principal(admin,PrincipalInput(name=principal['name'],role_id=role['id'],active=False),principal['id'])
    with pytest.raises(IAMError):iam.authenticate(fresh['credential'])


def test_api_token_cannot_be_exchanged_for_jwt_or_manage_auth_and_admin(repo,security,iam_setup):
    iam,admin,_,auth=iam_setup
    role=make_role(iam,admin,statements=[{'effect':'Allow','actions':['*'],'resources':['*']}])
    principal,key=make_identity(iam,admin,role);headers={'Authorization':'Bearer '+key['credential']}
    response=auth.get('/session',headers=headers)
    assert response.status_code==200 and response.json()['principal_type']=='api'
    assert 'access_token' not in response.json()
    for path in ['/accounts','/iam/roles','/portal-session']:
        assert auth.get(path,headers=headers).status_code==401
    assert auth.post('/refresh',headers=headers).status_code==401
    assert auth.post('/totp/enrollment',headers=headers).status_code==401
    async def current(token=Depends(bearer)):return iam.authenticate(token)
    administration=TestClient(admin_app(repo,current))
    for path in ['/accounts','/models','/activity','/role-policies','/iam/roles','/iam/principals']:
        assert administration.get(path,headers=headers).status_code==403,path
    repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    agent=TestClient(chat_app(repo,current,lambda _:DeckAgent(repo,FakePlanner(),FakeSuppliers()),verified))
    assert agent.get('/models',headers=headers).status_code==200
    assert agent.get('/internal/legality/status',headers=headers).status_code==403
    assert agent.post('/internal/legality/refresh',headers=headers).status_code==403
    response=agent.post('/executions',headers=headers,json={'text':'exact Test','model_id':'fixture'})
    assert 'event: result' in response.text
    human_chat=repo.new_conversation(admin.id,'Private human conversation')
    assert agent.get('/conversations/'+human_chat.id,headers=headers).status_code==404


def test_human_assignment_revokes_old_sessions_and_last_iam_admin_is_protected(repo,security,iam_setup):
    iam,admin,jwt,auth=iam_setup
    # Migrate the root fixture to the built-in IAM role.
    with repo.transaction() as s:
        s.add(IAMRole(id=BUILTIN_ROLE_IDS['admin'],name='Administrator',policy=legacy_policy('admin'),daily_token_limit=200000))
        s.flush();s.get(type(admin),admin.id).iam_role_id=BUILTIN_ROLE_IDS['admin']
    empty=make_role(iam,admin,'Empty',statements=[])
    with pytest.raises(IAMError,match='at least one'):
        iam.assign_human_role(admin,admin.id,empty['id'])
    with pytest.raises(IAMError,match='at least one'):
        iam.save_role(admin,RoleInput(name='Administrator',policy=InlinePolicy(statements=[])),BUILTIN_ROLE_IDS['admin'])
    user=repo.add_user('human','unused');repo.update_user(user.id,totp_secret='enrolled')
    old=security.tokens.issue(repo.user(user_id=user.id))
    role=make_role(iam,admin,'Read models only',statements=[{'effect':'Allow','actions':['agent:models:list'],'resources':['*']}])
    iam.assign_human_role(admin,user.id,role['id'])
    assert auth.get('/session',headers={'Authorization':'Bearer '+old}).status_code==401
    fresh=security.tokens.issue(repo.user(user_id=user.id));session=auth.get('/session',headers={'Authorization':'Bearer '+fresh}).json()
    assert session['role']==role['id'] and session['role_name']=='Read models only'
    assert session['policy_statements']==role['effective_statements']


def test_iam_management_requires_human_permissions_and_scopes_token_parent(repo,security,iam_setup):
    iam,admin,jwt,auth=iam_setup
    user=repo.add_user('ordinary','unused');repo.update_user(user.id,totp_secret='enrolled')
    header={'Authorization':'Bearer '+security.tokens.issue(repo.user(user_id=user.id))}
    assert auth.get('/iam/roles',headers=header).status_code==403
    admin_header={'Authorization':'Bearer '+jwt}
    response=auth.post('/iam/roles',headers=admin_header,json={'name':'Role','daily_token_limit':100,'policy':{'statements':[{'effect':'Allow','actions':['agent:*'],'resources':['*']}]}})
    assert response.status_code==201
    role=response.json();first,key=make_identity(iam,admin,role);other,_=make_identity(iam,admin,role,'Second')
    assert auth.delete(f"/iam/principals/{other['id']}/tokens/{key['metadata']['id']}",headers=admin_header).status_code==404
    assert iam.authenticate(key['credential']).id==first['id']
    assert auth.post(f"/iam/principals/{first['id']}/tokens",headers=admin_header,json={'name':'bad','expires_in_days':0}).status_code==422


def test_unknown_actions_fail_validation_and_default_deny_is_not_silent_allow():
    with pytest.raises(ValueError):InlinePolicy(statements=[{'effect':'Allow','actions':['typo:operation'],'resources':['*']}])
    assert not permitted([], 'agent:models:list')
    assert not permitted([{'effect':'Allow','actions':['agent:*'],'resources':['model:one']}],'agent:models:invoke','model:two')


@pytest.mark.asyncio
async def test_remote_introspection_and_revocation_between_model_calls(repo,iam_setup,monkeypatch):
    from shared.api import remote_auth
    from services.orchestrator.models import GuardedModel,invocation_context
    from langchain_core.messages import AIMessage
    iam,admin,_,auth=iam_setup
    role=make_role(iam,admin);principal,key=make_identity(iam,admin,role)
    class HTTP:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def get(self,url,headers):return auth.get('/session',headers=headers)
    monkeypatch.setattr('shared.api.httpx.AsyncClient',HTTP)
    authenticate=remote_auth('http://auth')
    caller=await authenticate(token=key['credential'])
    assert caller.id==principal['id'] and caller.principal_type=='api'
    assert caller.role==role['id'] and caller.key_reference==key['metadata']['id']
    policy=repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    class Runnable:
        calls=0
        async def ainvoke(self,messages,**kwargs):
            self.calls+=1
            return AIMessage(content='Synthetic',usage_metadata={'input_tokens':1,'output_tokens':1,'total_tokens':2})
    runnable=Runnable();guard=GuardedModel(runnable,repo,policy,require_context=True)
    context=invocation_context.set((caller,authenticate))
    try:
        await guard.ainvoke([])
        iam.revoke_token(admin,principal['id'],key['metadata']['id'])
        with pytest.raises(HTTPException) as error:await guard.ainvoke([])
        assert error.value.status_code==401 and runnable.calls==1
        assert RolePolicies(repo).usage(caller.id,caller.role)['total_tokens']==2
    finally:invocation_context.reset(context)


def test_rotated_token_keeps_execution_ownership_and_default_deny_blocks_endpoints(repo,iam_setup):
    iam,admin,_,_=iam_setup
    role=make_role(iam,admin);identity,first=make_identity(iam,admin,role)
    other,other_key=make_identity(iam,admin,role,'Other owner')
    async def current(token=Depends(bearer)):return iam.authenticate(token)
    repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    agent=TestClient(chat_app(repo,current,lambda _:DeckAgent(repo,FakePlanner(),FakeSuppliers()),verified))
    created=agent.post('/executions',headers={'Authorization':'Bearer '+first['credential']},json={'text':'exact Test','model_id':'fixture'})
    execution_id=json.loads(created.text.split('event: execution\ndata: ',1)[1].split('\n',1)[0])['id']
    rotated=iam.create_token(admin,identity['id'],TokenInput(name='Replacement'))
    iam.revoke_token(admin,identity['id'],first['metadata']['id'])
    assert agent.get('/executions/'+execution_id,headers={'Authorization':'Bearer '+rotated['credential']}).status_code==200
    assert agent.get('/executions/'+execution_id,headers={'Authorization':'Bearer '+other_key['credential']}).status_code==404
    empty=make_role(iam,admin,'No access',statements=[])
    iam.save_principal(admin,PrincipalInput(name=identity['name'],role_id=empty['id']),identity['id'])
    for path in ['/models','/usage','/conversations','/preferences','/currencies','/executions/'+execution_id]:
        assert agent.get(path,headers={'Authorization':'Bearer '+rotated['credential']}).status_code==403,path


def test_credential_responses_are_not_cacheable(iam_setup):
    iam,admin,jwt,auth=iam_setup
    role=make_role(iam,admin);principal,_=make_identity(iam,admin,role)
    response=auth.post('/iam/principals/'+principal['id']+'/tokens',headers={'Authorization':'Bearer '+jwt},json={'name':'Private'})
    assert response.status_code==201
    assert response.headers['Cache-Control']=='no-store'
    assert 'credential' in response.json()


@pytest.mark.skipif(not __import__('os').getenv('TEST_ROLE_POSTGRES_URL'),reason='Requires isolated local PostgreSQL')
def test_postgres_serializes_hierarchy_cycles_and_last_admin_edits(security):
    import os
    from concurrent.futures import ThreadPoolExecutor
    from sqlalchemy import create_engine,text
    from sqlalchemy.orm import sessionmaker
    from shared.db import Base,User
    from shared.repository import Repository
    engine=create_engine(os.environ['TEST_ROLE_POSTGRES_URL'])
    assert engine.url.host=='127.0.0.1' and engine.url.database=='tcg_dashboard_test'
    with engine.begin() as connection:connection.execute(text('CREATE SCHEMA IF NOT EXISTS pokemon_tcg_poc'))
    Base.metadata.drop_all(engine);Base.metadata.create_all(engine)
    repo=Repository(sessionmaker(engine,expire_on_commit=False));iam=IAM(repo)
    first=repo.add_user('pg-first','synthetic','admin');second=repo.add_user('pg-second','synthetic','admin')
    a=make_role(iam,first,'A');b=make_role(iam,first,'B')
    def link(pair):
        child,parent=pair
        try:iam.save_role(first,RoleInput(name=child['name'],parent_id=parent['id']),child['id']);return True
        except IAMError:return False
    with ThreadPoolExecutor(max_workers=2) as pool:assert sum(pool.map(link,[(a,b),(b,a)]))==1
    roots=[make_role(iam,first,'Root '+str(i),statements=[{'effect':'Allow','actions':['*'],'resources':['*']}]) for i in range(2)]
    for user,role in zip([first,second],roots):iam.assign_human_role(first,user.id,role['id'])
    def remove_root(pair):
        user,role=pair
        try:iam.save_role(user,RoleInput(name=role['name'],policy=InlinePolicy(statements=[])),role['id']);return True
        except IAMError:return False
    with ThreadPoolExecutor(max_workers=2) as pool:assert sum(pool.map(remove_root,zip([first,second],roots)))==1
    with repo.transaction() as s:
        assert sum(permitted(resolve_role(s,u.iam_role_id)['statements'],'iam:roles:write') for u in s.scalars(select(User)))==1
    engine.dispose()
