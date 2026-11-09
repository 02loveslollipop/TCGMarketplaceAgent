from datetime import timedelta
import pytest
import pyotp
from fastapi.testclient import TestClient
from sqlalchemy import select,update
from services.auth.app import create_app
from services.auth.security import AuthenticationError,hash_password,verify_password
from services.auth.webauthn import WebAuthn
from shared.contracts import utcnow
from shared.db import Challenge,RecoveryCode
from shared.repository import redact
from tests.test_security import security
from tests.test_webauthn import Authenticator


PASSWORD='fixture-password-long'


def initial(repo,security,name='fixture'):
    user=repo.add_user(name,hash_password(PASSWORD))
    token=security.login(name,PASSWORD)['enrollment_token']
    return user,token


def totp_setup(repo,security,name='fixture'):
    user,token=initial(repo,security,name)
    seed=security.onboarding_totp(token)['secret']
    result=security.onboarding_totp(token,pyotp.TOTP(seed).now())
    return repo.user(user_id=user.id),result['recovery_codes'],seed


def test_initial_limited_token_no_access_until_confirmed_and_plaintext_only_once(repo,security):
    user,token=initial(repo,security)
    client=TestClient(create_app(repo,security))
    for old in [token,security.tokens.issue(user)]:
        headers={'Authorization':f'Bearer {old}'}
        for path in ['/session','/accounts','/webauthn/credentials','/recovery/status']:
            assert client.get(path,headers=headers).status_code==401
        assert client.post('/recovery/regenerate',headers=headers,json={'password':PASSWORD}).status_code==401
    headers={'Authorization':f'Bearer {token}'}
    seed=client.post('/onboarding/totp/enrollment',headers=headers).json()['secret']
    response=client.post('/onboarding/totp/confirmation',headers=headers,json={'code':pyotp.TOTP(seed).now()})
    assert response.status_code==200
    result=response.json();assert 'access_token' not in result and len(result['recovery_codes'])==10
    assert client.post('/onboarding/totp/confirmation',headers=headers,json={'code':pyotp.TOTP(seed).now()}).status_code==401
    with repo.transaction() as session:
        rows=list(session.scalars(select(RecoveryCode)))
        assert len(rows)==10 and all(row.code_hash.startswith('$argon2id$') for row in rows)
        assert all(code not in repr(row.__dict__) for row in rows for code in result['recovery_codes'])
    login=security.login(user.username,PASSWORD)
    verified=security.recover(login['challenge_token'],result['recovery_codes'][0])
    assert 'access_token' not in verified
    assert security.current(verified['enrollment_token'],'enrollment').id==user.id
    assert security.recovery_remaining(user)==0
    assert client.get('/session',headers={'Authorization':f"Bearer {verified['enrollment_token']}"}).status_code==401


@pytest.mark.parametrize('change',['expired','consumed','inactive','version'])
def test_enrollment_expiry_replay_and_account_state(repo,security,change):
    user,token=initial(repo,security)
    claims=security.tokens.read(token,'enrollment')
    if change in {'expired','consumed'}:
        with repo.transaction() as session:
            session.execute(update(Challenge).where(Challenge.id==claims['challenge_id']).values(**({'expires_at':utcnow()-timedelta(seconds=1)} if change=='expired' else {'consumed':True})))
    else:repo.update_user(user.id,**({'active':False} if change=='inactive' else {'token_version':1}))
    with pytest.raises(AuthenticationError):security.onboarding_totp(token)


def test_enrollment_attempts_and_separate_pending_secrets(repo,security):
    user,a=initial(repo,security)
    b=security.login(user.username,PASSWORD)['enrollment_token']
    first=security.onboarding_totp(a)['secret'];second=security.onboarding_totp(b)['secret']
    assert first!=second
    for _ in range(5):
        with pytest.raises(AuthenticationError):security.onboarding_totp(a,'not-code')
    with pytest.raises(AuthenticationError):security.onboarding_totp(a,pyotp.TOTP(first).now())
    assert security.onboarding_totp(b,pyotp.TOTP(second).now())['enrolled']


def test_webauthn_onboarding_binding_multiple_keys_and_either_signs_in(repo,security):
    user,token=initial(repo,security)
    service=WebAuthn(security);first=Authenticator();second=Authenticator(synced=True)
    parent=security.tokens.read(token,'enrollment')['challenge_id']
    request=service.begin_registration(user,'Phone',parent)
    with pytest.raises(AuthenticationError):service.finish_registration(user,request['challenge_id'],first.register(request['options']))
    request=service.begin_registration(user,'Phone',parent)
    result=service.finish_registration(user,request['challenge_id'],first.register(request['options']),parent)
    assert len(result['recovery_codes'])==10 and 'access_token' not in result
    user=repo.user(user_id=user.id)
    request=service.begin_registration(user,'Physical')
    service.finish_registration(user,request['challenge_id'],second.register(request['options']))
    user=repo.user(user_id=user.id)
    assert len(repo.webauthn_credentials(user.id))==2 and security.recovery_remaining(user)==10
    for key in [first,second]:
        login=security.login(user.username,PASSWORD)['challenge_token'];request=service.begin_authentication(login)
        assert service.finish_authentication(login,request['challenge_id'],key.assert_login(request['options']))['access_token']


def test_recovery_revokes_factors_sessions_and_requires_fresh_enrollment(repo,security):
    user,codes,seed=totp_setup(repo,security)
    key=Authenticator();service=WebAuthn(security)
    request=service.begin_registration(user,'Fixture key')
    service.finish_registration(user,request['challenge_id'],key.register(request['options']))
    user=repo.user(user_id=user.id)
    old_access=security.tokens.issue(user)
    login=security.login(user.username,PASSWORD)['challenge_token']
    other_login=security.login(user.username,PASSWORD)['challenge_token']
    pending_key=service.begin_authentication(other_login)
    with pytest.raises(AuthenticationError):security.recover(login,'incorrect')
    assert security.has_factor(repo.user(user_id=user.id))
    result=security.recover(login,codes[0])
    assert 'access_token' not in result and result['recovery_reset']
    assert not security.has_factor(repo.user(user_id=user.id))
    assert not repo.webauthn_credentials(user.id)
    assert security.recovery_remaining(user)==0
    for token in [old_access,result['enrollment_token']]:
        with pytest.raises(AuthenticationError):security.current(token)
    for token in [login,other_login]:
        with pytest.raises(AuthenticationError):security.recover(token,codes[1])
    with pytest.raises(AuthenticationError):service.finish_authentication(other_login,pending_key['challenge_id'],key.assert_login(pending_key['options']))
    token=result['enrollment_token']
    new_seed=security.onboarding_totp(token)['secret']
    assert new_seed!=seed
    new_codes=security.onboarding_totp(token,pyotp.TOTP(new_seed).now())['recovery_codes']
    assert len(new_codes)==10 and not set(new_codes)&set(codes)
    user=repo.user(user_id=user.id)
    assert security.has_factor(user)
    with pytest.raises(AuthenticationError):security.current(token,'enrollment')
    fresh=security.login(user.username,PASSWORD)['challenge_token']
    with pytest.raises(AuthenticationError):security.recover(fresh,codes[1])
    assert security.recover(fresh,new_codes[0])['enrollment_token']


@pytest.mark.parametrize('change',['expired','consumed','inactive','version','attempts'])
def test_recovery_rejects_invalid_password_challenge_or_account(repo,security,change):
    user,codes,_=totp_setup(repo,security)
    token=security.login(user.username,PASSWORD)['challenge_token']
    parent=security.tokens.read(token,'second_factor')['challenge_id']
    if change in {'expired','consumed','attempts'}:
        values={'expires_at':utcnow()-timedelta(seconds=1)} if change=='expired' else {'consumed':True} if change=='consumed' else {'attempts':5}
        with repo.transaction() as session:session.execute(update(Challenge).where(Challenge.id==parent).values(**values))
    else:repo.update_user(user.id,**({'active':False} if change=='inactive' else {'token_version':user.token_version+1}))
    with pytest.raises(AuthenticationError):security.recover(token,codes[0])
    assert security.recovery_remaining(user)==10


def test_recovery_attempt_limit_purpose_and_redaction(repo,security):
    user,codes,_=totp_setup(repo,security)
    token=security.login(user.username,PASSWORD)['challenge_token']
    for _ in range(5):
        with pytest.raises(AuthenticationError):security.recover(token,'incorrect')
    with pytest.raises(AuthenticationError):security.recover(token,codes[0])
    with pytest.raises(AuthenticationError):security.recover(security.tokens.issue(user),codes[0])
    assert redact({'recovery_codes':codes,'code_hash':'hash'})=={'recovery_codes':'[REDACTED]','code_hash':'[REDACTED]'}
