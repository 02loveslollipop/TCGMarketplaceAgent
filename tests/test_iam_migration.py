"""Upgrade safety on an explicitly isolated PostgreSQL database."""
import os
import pytest
import psycopg
from psycopg import sql
from sqlalchemy import create_engine,text,select
from sqlalchemy.orm import sessionmaker
from shared.db import Base,User,RolePolicy,DailyTokenUsage,APIToken,SCHEMA
from shared.repository import Repository
from shared.iam import BUILTIN_ROLE_IDS,resolve_role,permitted
from shared.role_policy import usage_day
from shared.contracts import utcnow
from scripts.provision import migrate_iam,SERVICE_TABLES

@pytest.mark.skipif(not os.getenv('TEST_ROLE_POSTGRES_URL'),reason='Requires isolated local PostgreSQL')
def test_iam_upgrade_preserves_existing_security_and_access():
    url=os.environ['TEST_ROLE_POSTGRES_URL'];engine=create_engine(url)
    assert engine.url.host=='127.0.0.1' and engine.url.database=='tcg_dashboard_test'
    with engine.begin() as c:c.execute(text('CREATE SCHEMA IF NOT EXISTS pokemon_tcg_poc'))
    Base.metadata.drop_all(engine);Base.metadata.create_all(engine)
    repo=Repository(sessionmaker(engine,expire_on_commit=False))
    user=repo.add_user('migration-admin','SYNTHETIC-HASH','admin')
    repo.update_user(user.id,token_version=7,totp_secret='SYNTHETIC-ENCRYPTED-FACTOR')
    with repo.transaction() as s:
        s.add(RolePolicy(role='admin',daily_token_limit=123456,allowed_model_ids=['fixture']))
        s.add(RolePolicy(role='user',daily_token_limit=6543,allowed_model_ids=[]))
        s.add(DailyTokenUsage(user_id=user.id,usage_date=usage_day(),input_tokens=10,output_tokens=20,total_tokens=30))
    dsn=url.replace('postgresql+psycopg:','postgresql:')
    with psycopg.connect(dsn) as c:
        # Emulate the prior schema without loading an old source revision.
        c.execute(sql.SQL('ALTER TABLE {}.users DROP COLUMN iam_role_id').format(sql.Identifier(SCHEMA)))
        for table in ['api_tokens','api_principals','iam_roles']:
            c.execute(sql.SQL('DROP TABLE {}.{}').format(sql.Identifier(SCHEMA),sql.Identifier(table)))
        for service in SERVICE_TABLES:
            name='pokemon_poc_'+service
            if not c.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(name,)).fetchone():
                c.execute(sql.SQL('CREATE ROLE {} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT').format(sql.Identifier(name)))
            c.execute(sql.SQL('GRANT USAGE ON SCHEMA {} TO {}').format(sql.Identifier(SCHEMA),sql.Identifier(name)))
    for _ in range(2):
        with psycopg.connect(dsn) as c:migrate_iam(c)
    with repo.transaction() as s:
        row=s.get(User,user.id);role=resolve_role(s,row.iam_role_id)
        assert (row.password_hash,row.totp_secret,row.token_version)==('SYNTHETIC-HASH','SYNTHETIC-ENCRYPTED-FACTOR',7)
        assert row.iam_role_id==BUILTIN_ROLE_IDS['admin']
        assert role['daily_token_limit']==123456
        assert permitted(role['statements'],'agent:models:invoke','model:fixture')
        assert not permitted(role['statements'],'agent:models:invoke','model:other')
        assert permitted(role['statements'],'iam:roles:write')
        assert not permitted(resolve_role(s,BUILTIN_ROLE_IDS['user'])['statements'],'agent:models:invoke','model:fixture')
        assert s.get(DailyTokenUsage,(user.id,usage_day())).total_tokens==30
        assert list(s.scalars(select(APIToken)))==[]
    with psycopg.connect(dsn) as c:
        def has(service,table,permission):
            return c.execute('SELECT has_table_privilege(%s,%s,%s)',('pokemon_poc_'+service,SCHEMA+'.'+table,permission)).fetchone()[0]
        assert has('auth','api_tokens','SELECT') and has('auth','api_tokens','INSERT') and has('auth','api_tokens','UPDATE')
        assert not has('auth','api_tokens','DELETE')
        for service in ['admin','orchestrator']:
            assert not has(service,'api_tokens','SELECT')
            assert has(service,'iam_roles','SELECT') and not has(service,'iam_roles','UPDATE')
    engine.dispose()
