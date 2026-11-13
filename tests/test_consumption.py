from datetime import datetime,timezone,timedelta
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from shared.db import AuditLog,DailyTokenUsage,ModelPolicy
from shared.consumption import report,save_pricing,price_snapshot
from shared.role_policy import RolePolicies,PolicyError,usage_day
from shared.iam import BUILTIN_ROLE_IDS
from services.admin.app import create_app as admin_app
from services.orchestrator.app import create_app as chat_app
from tests.test_api import current,verified,headers


def model(repo):
    return repo.save_model('luna',label='Luna',provider='openai',api_id='gpt-6-luna',enabled=True)


def test_call_snapshots_role_and_pricing_and_accounts_only_once(repo):
    model(repo);policies=RolePolicies(repo)
    ticket=policies.begin_call('alice','user','luna',principal_name='Alice',execution_id='execution')
    save_pricing(repo,'luna',{'input_per_million':'50','output_per_million':'100','currency':'USD','note':'Synthetic contract'},'admin')
    policies.finish_call('alice',ticket,{'input_tokens':1000,'output_tokens':200})
    policies.finish_call('alice',ticket,{'input_tokens':1000,'output_tokens':200})
    second=policies.begin_call('alice','admin','luna',principal_name='Alice')
    policies.finish_call('alice',second,{'input_tokens':1000,'output_tokens':200})
    data=report(repo);assert data['summary']['total_tokens']==2400 and data['summary']['verified_calls']==2
    assert {r['id']:r['total_tokens'] for r in data['roles']}=={BUILTIN_ROLE_IDS['user']:1200,BUILTIN_ROLE_IDS['admin']:1200}
    assert Decimal(data['summary']['estimated_cost_usd'])==Decimal('.0002')+Decimal('.07')
    with repo.transaction() as session:
        rows=list(session.scalars(select(AuditLog).where(AuditLog.action=='model_usage')))
        assert len(rows)==2 and rows[0].execution_id=='execution'
        assert rows[0].details['pricing']['input_per_million']=='0.10'
    filtered=report(repo,role_id=BUILTIN_ROLE_IDS['user'])
    assert filtered['summary']['total_tokens']==1200 and filtered['principals'][0]['name']=='Alice'


def test_daily_legacy_usage_is_retained_without_assigning_current_roles_or_costs(repo):
    with repo.transaction() as session:
        session.add(DailyTokenUsage(user_id='legacy',usage_date=usage_day(),input_tokens=700,output_tokens=100,total_tokens=800))
    data=report(repo)
    assert data['summary']['total_tokens']==800 and data['summary']['estimated_cost_usd'] is None
    assert data['summary']['unpriced_tokens']==800 and data['roles'][0]['id']=='unattributed'
    assert report(repo,role_id=BUILTIN_ROLE_IDS['user'])['summary']['total_tokens']==0


def test_new_records_and_historical_residual_reconcile_without_double_counting(repo):
    model(repo);policies=RolePolicies(repo)
    t=policies.begin_call('alice','user','luna');policies.finish_call('alice',t,{'input_tokens':50,'output_tokens':10})
    with repo.transaction() as session:
        row=session.get(DailyTokenUsage,('alice',usage_day()));row.input_tokens+=100;row.output_tokens+=20;row.total_tokens+=120
    d=report(repo)
    assert d['summary']['total_tokens']==180 and d['summary']['priced_tokens']==60 and d['summary']['unpriced_tokens']==120
    assert sum(row['total_tokens'] for row in d['roles'])==180


def test_rejected_and_unverified_calls_are_not_reported_as_successful_zero_cost_usage(repo):
    model(repo);policies=RolePolicies(repo)
    t=policies.begin_call('unknown','user','luna');policies.finish_call('unknown',t,None)
    t=policies.begin_call('rejected','user','luna');policies.finish_call('rejected',t,None,rejected=True)
    d=report(repo);assert d['summary']['unverified_calls']==1 and d['summary']['rejected_calls']==1
    assert d['summary']['estimated_cost_usd'] is None and d['summary']['total_tokens']==0
    assert next(row for row in d['principals'] if row['id']=='unknown')['unverified_usage']


def test_start_day_and_role_snapshot_survive_japan_midnight(repo,monkeypatch):
    import shared.role_policy as module
    clock=[datetime(2026,11,12,14,59,tzinfo=timezone.utc)]
    monkeypatch.setattr(module,'utcnow',lambda:clock[0]);model(repo)
    p=RolePolicies(repo);t=p.begin_call('alice','user','luna');clock[0]+=timedelta(minutes=2)
    p.finish_call('alice',t,{'input_tokens':30,'output_tokens':5})
    old=report(repo,t[0],t[0]);assert old['summary']['total_tokens']==35
    assert report(repo,t[0]+timedelta(days=1),t[0]+timedelta(days=1))['summary']['total_tokens']==0
    with pytest.raises(ValueError,match='90 days'):report(repo,t[0]-timedelta(days=91),t[0])


def test_permissions_and_pricing_validation(repo):
    model(repo);client=TestClient(admin_app(repo,current))
    assert client.get('/model-pricing',headers=headers()).status_code==403
    assert client.put('/model-pricing/luna',headers=headers('admin'),json={'input_per_million':'NaN','output_per_million':'1','note':'Bad'}).status_code==422
    assert client.put('/model-pricing/luna',headers=headers('admin'),json={'input_per_million':'1'}).status_code==422
    assert client.put('/model-pricing/luna',headers=headers('admin'),json={'input_per_million':'0','output_per_million':'0','note':'Explicit free contract'}).status_code==200
    chat=TestClient(chat_app(repo,current,lambda policy:None,verified))
    assert chat.get('/internal/consumption',headers=headers()).status_code==403
    assert chat.get('/internal/consumption?start=bad',headers=headers('admin')).status_code==422
    assert chat.get('/internal/consumption',headers=headers('admin')).status_code==200


def test_model_identity_changes_invalidate_custom_rates_and_block_stale_admission(repo):
    model(repo);save_pricing(repo,'luna',{'currency':'USD','input_per_million':'1','output_per_million':'2','note':'Synthetic'},'admin')
    repo.save_model('luna',label='Changed',provider='mistral',api_id='mistral-medium-latest',enabled=True)
    with repo.transaction() as session:assert price_snapshot(session,session.get(ModelPolicy,'luna')) is None
    with pytest.raises(PolicyError,match='changed before call admission'):
        RolePolicies(repo).begin_call('alice','user','luna',expected_provider='openai',expected_api_id='gpt-6-luna')
    assert not RolePolicies(repo).usage('alice','user')['in_progress']


def test_principal_and_model_filters_recompute_all_totals(repo):
    model(repo);p=RolePolicies(repo)
    for principal,model_id in [('alice','luna'),('test-api','unknown')]:
        t=p.begin_call(principal,'user',model_id,principal_type='api' if principal=='test-api' else 'user')
        p.finish_call(principal,t,{'input_tokens':100,'output_tokens':20})
    r=report(repo,principal_id='test-api');assert r['summary']['total_tokens']==120 and r['summary']['estimated_cost_usd'] is None
    assert len(r['principals'])==1 and r['principals'][0]['principal_type']=='api'
    r=report(repo,model_id='luna');assert r['summary']['total_tokens']==120 and len(r['models'])==1


def test_postgres_consumption_ledger_aggregation():
    import os
    from uuid import uuid4
    from sqlalchemy import create_engine,text,delete
    from sqlalchemy.orm import sessionmaker
    from shared.db import Base,SCHEMA
    from shared.repository import Repository
    url=os.getenv('TEST_ROLE_POSTGRES_URL')
    if not url:pytest.skip('Explicit isolated PostgreSQL test URL required.')
    engine=create_engine(url,hide_parameters=True)
    with engine.begin() as connection:connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS {SCHEMA}'))
    Base.metadata.create_all(engine)
    repo=Repository(sessionmaker(engine,expire_on_commit=False));pid='usage-'+uuid4().hex[:24];mid='model-'+uuid4().hex[:24]
    try:
        repo.save_model(mid,label='Postgres usage fixture',provider='openai',api_id='gpt-6-luna',enabled=True)
        save_pricing(repo,mid,{'currency':'USD','input_per_million':'.1','output_per_million':'.5','note':'Isolated test'},'test')
        policy=RolePolicies(repo);ticket=policy.begin_call(pid,'user',mid,principal_name='Postgres test')
        policy.finish_call(pid,ticket,{'input_tokens':1000,'output_tokens':200})
        data=report(repo,principal_id=pid,model_id=mid)
        assert data['summary']['total_tokens']==1200 and data['summary']['verified_calls']==1
        assert Decimal(data['summary']['estimated_cost_usd'])==Decimal('.0002')
        assert data['roles'][0]['id']==BUILTIN_ROLE_IDS['user']
    finally:
        with repo.transaction() as session:
            session.execute(delete(AuditLog).where((AuditLog.details['principal_id'].as_string()==pid)|(AuditLog.details['model_id'].as_string()==mid)))
            session.execute(delete(DailyTokenUsage).where(DailyTokenUsage.user_id==pid))
            session.execute(delete(ModelPolicy).where(ModelPolicy.id==mid))
        engine.dispose()


def test_admin_usage_enriches_current_quota_without_reassigning_historical_usage(repo):
    import httpx
    from shared.api import Principal
    model(repo);p=RolePolicies(repo);t=p.begin_call('alice','user','luna',principal_name='Alice')
    p.finish_call('alice',t,{'input_tokens':1000,'output_tokens':200})
    async def transport(request):
        if request.url.path=='/internal/consumption':return httpx.Response(200,json=report(repo))
        if request.url.path=='/accounts':return httpx.Response(200,json=[{'id':'alice','username':'Alice','role':'admin'}])
        if request.url.path=='/iam/principals':return httpx.Response(200,json=[])
        return httpx.Response(404)
    http=httpx.AsyncClient(transport=httpx.MockTransport(transport))
    client=TestClient(admin_app(repo,current,client=http))
    response=client.get('/consumption',headers=headers('admin'));assert response.status_code==200
    d=response.json();assert d['principals'][0]['current_role_name']=='Administrator'
    assert d['principals'][0]['daily_token_limit']==200000 and d['principals'][0]['today_tokens']==1200
    assert d['roles'][0]['id']==BUILTIN_ROLE_IDS['user']
    assert 'current_daily' not in d
    async def api_principal():return Principal('api','API','admin',principal_type='api')
    denied=TestClient(admin_app(repo,api_principal,client=http))
    assert denied.get('/consumption').status_code==403
    assert denied.get('/model-pricing').status_code==403
