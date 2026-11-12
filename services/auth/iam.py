"""Human-managed roles and nonhuman identities with replaceable API credentials."""
from datetime import timedelta,timezone
import hashlib
import hmac
import re
import secrets
from uuid import UUID,uuid4
from fastapi import Depends,HTTPException
from pydantic import BaseModel,ConfigDict,Field,field_validator
from sqlalchemy import select,func
from sqlalchemy.exc import IntegrityError
from shared.api import Principal,require_permission
from shared.contracts import utcnow
from shared.db import APIPrincipal,APIToken,IAMRole,User,AuditLog,DailyTokenUsage
from shared.iam import ACTIONS,BUILTIN_ROLE_IDS,IAMError,RoleInput,resolve_role,ensure_human_administrator,lock_role_graph

TOKEN_PATTERN=re.compile(r'^tcg_api_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$')

def aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


class PrincipalInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name: str=Field(min_length=1,max_length=80)
    description: str=Field(default='',max_length=500)
    role_id: str=Field(min_length=1,max_length=36)
    active: bool=True

    @field_validator('name')
    @classmethod
    def valid_name(cls,value):
        value=value.strip()
        if not value:raise ValueError('A principal name is required.')
        return value


class TokenInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name: str=Field(min_length=1,max_length=80)
    expires_in_days: int=Field(default=30,ge=1,le=365,strict=True)

    @field_validator('name')
    @classmethod
    def valid_name(cls,value):
        value=value.strip()
        if not value:raise ValueError('A token name is required.')
        return value


class AssignmentInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    role_id: str=Field(min_length=1,max_length=36)


class IAM:
    def __init__(self,repo):self.repo=repo

    def human(self,user,token=''):
        with self.repo.transaction() as session:
            role=resolve_role(session,user.iam_role_id or user.role)
            return Principal(user.id,user.username,role['id'],token,'user',role['name'],role['statements'])

    @staticmethod
    def role_view(session,row):
        effective=resolve_role(session,row.id)
        return {'id':row.id,'name':row.name,'description':row.description,'parent_id':row.parent_id,
                'policy':row.policy,'daily_token_limit':row.daily_token_limit,
                'effective_daily_token_limit':effective['daily_token_limit'],'effective_statements':effective['statements'],
                'inheritance':effective['inheritance'],'builtin':row.id in BUILTIN_ROLE_IDS.values(),'builtin_key':next((key for key,value in BUILTIN_ROLE_IDS.items() if value==row.id),None),
                'updated_at':row.updated_at.isoformat()}

    def roles(self):
        with self.repo.transaction() as session:
            return [self.role_view(session,row) for row in session.scalars(select(IAMRole).order_by(IAMRole.name))]

    def save_role(self,actor,body,role_id=None):
        resource='role:'+role_id if role_id else '*'
        require_permission(self.human(actor),'iam:roles:write',resource)
        with self.repo.transaction() as session:
            lock_role_graph(session)
            row=session.get(IAMRole,role_id) if role_id else IAMRole(id=str(uuid4()))
            if row is None:raise IAMError('IAM role not found.',404)
            if body.parent_id:
                parent=session.get(IAMRole,body.parent_id);seen={row.id}
                while parent:
                    if parent.id in seen or len(seen)>=64:raise IAMError('A role cannot inherit itself or create an inheritance cycle.',422)
                    seen.add(parent.id)
                    parent=session.get(IAMRole,parent.parent_id) if parent.parent_id else None
                if not session.get(IAMRole,body.parent_id):raise IAMError('Choose an existing parent role.',422)
            row.name=body.name;row.description=body.description;row.parent_id=body.parent_id
            row.policy=body.policy.model_dump();row.daily_token_limit=body.daily_token_limit;row.updated_at=utcnow()
            session.add(row);session.flush();ensure_human_administrator(session)
            session.add(AuditLog(action='iam_role_saved',details={'actor_id':actor.id,'role_id':row.id,'name':row.name,'parent_id':row.parent_id,'policy':row.policy,'daily_limit':row.daily_token_limit}))
            return self.role_view(session,row)

    def delete_role(self,actor,role_id):
        require_permission(self.human(actor),'iam:roles:write','role:'+role_id)
        with self.repo.transaction() as session:
            lock_role_graph(session)
            row=session.get(IAMRole,role_id)
            if row is None:raise IAMError('IAM role not found.',404)
            if role_id in BUILTIN_ROLE_IDS.values():raise IAMError('Built-in roles cannot be deleted.',409)
            if (session.scalar(select(func.count()).select_from(IAMRole).where(IAMRole.parent_id==role_id))
                or session.scalar(select(func.count()).select_from(User).where(User.iam_role_id==role_id))
                or session.scalar(select(func.count()).select_from(APIPrincipal).where(APIPrincipal.role_id==role_id))):
                raise IAMError('Reassign principals and child roles before deleting this role.',409)
            session.delete(row);session.flush();ensure_human_administrator(session)
            session.add(AuditLog(action='iam_role_deleted',details={'actor_id':actor.id,'role_id':role_id}))
            return {'deleted':True}

    @staticmethod
    def principal_view(session,row):
        from shared.role_policy import usage_day
        role=resolve_role(session,row.role_id)
        usage=session.get(DailyTokenUsage,(row.id,usage_day()))
        return {'id':row.id,'name':row.name,'description':row.description,'role_id':row.role_id,'role_name':role['name'],
                'active':row.active,'created_at':row.created_at.isoformat(),'daily_token_limit':role['daily_token_limit'],
                'used_today':usage.total_tokens if usage else 0,'reset_timezone':'Asia/Tokyo',
                'created_by':row.created_by,'scope':'agent_only'}

    def principals(self):
        with self.repo.transaction() as session:
            return [self.principal_view(session,row) for row in session.scalars(select(APIPrincipal).order_by(APIPrincipal.name))]

    def save_principal(self,actor,body,principal_id=None):
        caller=self.human(actor)
        require_permission(caller,'iam:principals:write','principal:'+principal_id if principal_id else '*')
        with self.repo.transaction() as session:
            if not session.get(IAMRole,body.role_id):raise IAMError('Choose an existing IAM role.',422)
            row=session.get(APIPrincipal,principal_id) if principal_id else APIPrincipal(id=str(uuid4()),created_by=actor.id)
            if row is None:raise IAMError('API principal not found.',404)
            if not principal_id or row.role_id!=body.role_id:
                require_permission(caller,'iam:roles:assign','role:'+body.role_id)
            row.name=body.name;row.description=body.description;row.role_id=body.role_id;row.active=body.active;row.updated_at=utcnow()
            session.add(row);session.flush()
            session.add(AuditLog(action='api_principal_saved',details={'actor_id':actor.id,'principal_id':row.id,'role_id':row.role_id,'active':row.active}))
            return self.principal_view(session,row)

    def assign_human_role(self,actor,user_id,role_id):
        caller=self.human(actor)
        require_permission(caller,'admin:accounts:write','account:'+user_id)
        require_permission(caller,'iam:roles:assign','role:'+role_id)
        with self.repo.transaction() as session:
            lock_role_graph(session)
            users=list(session.scalars(select(User).order_by(User.id).with_for_update()))
            target=next((user for user in users if user.id==user_id),None)
            if not target:raise IAMError('Account not found.',404)
            role=resolve_role(session,role_id)
            if not session.get(IAMRole,role_id):raise IAMError('Choose an existing IAM role.',422)
            changed=target.iam_role_id!=role_id
            target.iam_role_id=role_id
            if changed:target.token_version+=1
            session.flush();ensure_human_administrator(session)
            session.add(AuditLog(action='human_iam_role_assigned',details={'actor_id':actor.id,'account_id':user_id,'role_id':role_id}))
            return {'id':target.id,'username':target.username,'role':target.role,'iam_role_id':role_id,'role_name':role['name'],
                    'active':target.active,'sign_in_again':changed and actor.id==target.id}

    @staticmethod
    def token_view(row):
        now=utcnow()
        state='revoked' if row.revoked_at else 'expired' if aware(row.expires_at)<=now else 'active'
        return {'id':row.id,'principal_id':row.principal_id,'name':row.name,'prefix':'tcg_api_'+UUID(row.id).hex[:8]+'…',
                'status':state,'created_at':row.created_at.isoformat(),'expires_at':row.expires_at.isoformat(),
                'last_used_at':row.last_used_at.isoformat() if row.last_used_at else None,
                'revoked_at':row.revoked_at.isoformat() if row.revoked_at else None,'created_by':row.created_by}

    def tokens(self,principal_id):
        with self.repo.transaction() as session:
            if not session.get(APIPrincipal,principal_id):raise IAMError('API principal not found.',404)
            return [self.token_view(row) for row in session.scalars(select(APIToken).where(APIToken.principal_id==principal_id).order_by(APIToken.created_at.desc()))]

    def create_token(self,actor,principal_id,body):
        require_permission(self.human(actor),'iam:tokens:write','principal:'+principal_id)
        with self.repo.transaction() as session:
            principal=session.get(APIPrincipal,principal_id)
            if principal is None:raise IAMError('API principal not found.',404)
            if not principal.active:raise IAMError('Enable the API principal before creating a token.',409)
            key_id=uuid4();raw='tcg_api_'+key_id.hex+'.'+secrets.token_urlsafe(32)
            row=APIToken(id=str(key_id),principal_id=principal_id,name=body.name,created_by=actor.id,
                         secret_hash=hashlib.sha256(raw.encode()).hexdigest(),expires_at=utcnow()+timedelta(days=body.expires_in_days))
            session.add(row);session.flush()
            session.add(AuditLog(action='api_credential_created',details={'actor_id':actor.id,'principal_id':principal_id,'key_reference':row.id,'expires_at':row.expires_at.isoformat()}))
            return {'credential':raw,'metadata':self.token_view(row)}

    def revoke_token(self,actor,principal_id,key_id):
        require_permission(self.human(actor),'iam:tokens:write','principal:'+principal_id)
        with self.repo.transaction() as session:
            row=session.scalar(select(APIToken).where(APIToken.id==key_id,APIToken.principal_id==principal_id).with_for_update())
            if row is None:raise IAMError('API token not found for this principal.',404)
            if row.revoked_at is None:
                row.revoked_at=utcnow()
                session.add(AuditLog(action='api_credential_revoked',details={'actor_id':actor.id,'principal_id':principal_id,'key_reference':key_id}))
            return {'revoked':True}

    def authenticate(self,raw):
        match=TOKEN_PATTERN.fullmatch(raw)
        if not match:raise IAMError('Invalid or expired API token.',401)
        key_id=str(UUID(hex=match.group(1)));now=utcnow()
        with self.repo.transaction() as session:
            key=session.get(APIToken,key_id)
            digest=hashlib.sha256(raw.encode()).hexdigest()
            if not hmac.compare_digest(key.secret_hash if key else '0'*64,digest) or key is None or key.revoked_at or aware(key.expires_at)<=now:
                raise IAMError('Invalid or expired API token.',401)
            principal=session.get(APIPrincipal,key.principal_id)
            if not principal or not principal.active:raise IAMError('The API principal is unavailable.',401)
            role=resolve_role(session,principal.role_id)
            if key.last_used_at is None or now-aware(key.last_used_at)>=timedelta(minutes=1):key.last_used_at=now
            return Principal(principal.id,principal.name,role['id'],raw,'api',role['name'],role['statements'],key.id)


def install_iam(app,repo,security,current):
    iam=IAM(repo)
    app.state.iam=iam
    @app.middleware('http')
    async def prevent_credential_caching(request,call_next):
        response=await call_next(request)
        if request.url.path.startswith('/iam/'):
            response.headers['Cache-Control']='no-store'
        return response
    @app.exception_handler(IAMError)
    async def iam_error(request,error):
        return await app.exception_handlers[HTTPException](request,HTTPException(error.status,str(error)))

    def authorize(user,action,resource='*'):
        return require_permission(iam.human(user),action,resource)

    @app.get('/iam/catalog')
    def catalog(user=Depends(current)):
        authorize(user,'iam:roles:read')
        return {'actions':[{'value':action,'id':action,'label':label} for action,label in ACTIONS.items()],
                'quota_timezone':'Asia/Tokyo','api_scope':'agent_only'}

    @app.get('/iam/roles')
    def roles(user=Depends(current)):
        authorize(user,'iam:roles:read');return iam.roles()

    @app.post('/iam/roles',status_code=201)
    def create_role(body:RoleInput,user=Depends(current)):
        try:return iam.save_role(user,body)
        except IntegrityError:raise HTTPException(409,'A role with that name already exists.') from None

    @app.put('/iam/roles/{role_id}')
    def update_role(role_id:str,body:RoleInput,user=Depends(current)):
        try:return iam.save_role(user,body,role_id)
        except IntegrityError:raise HTTPException(409,'A role with that name already exists.') from None

    @app.delete('/iam/roles/{role_id}')
    def delete_role(role_id:str,user=Depends(current)):
        return iam.delete_role(user,role_id)

    @app.put('/iam/accounts/{user_id}/role')
    def assign_role(user_id:str,body:AssignmentInput,user=Depends(current)):
        return iam.assign_human_role(user,user_id,body.role_id)

    @app.get('/iam/principals')
    def principals(user=Depends(current)):
        authorize(user,'iam:principals:read');return iam.principals()

    @app.post('/iam/principals',status_code=201)
    def create_principal(body:PrincipalInput,user=Depends(current)):
        try:return iam.save_principal(user,body)
        except IntegrityError:raise HTTPException(409,'A principal with that name already exists.') from None

    @app.put('/iam/principals/{principal_id}')
    def update_principal(principal_id:str,body:PrincipalInput,user=Depends(current)):
        try:return iam.save_principal(user,body,principal_id)
        except IntegrityError:raise HTTPException(409,'A principal with that name already exists.') from None

    @app.get('/iam/principals/{principal_id}/tokens')
    def tokens(principal_id:str,user=Depends(current)):
        authorize(user,'iam:tokens:read','principal:'+principal_id);return iam.tokens(principal_id)

    @app.post('/iam/principals/{principal_id}/tokens',status_code=201)
    def create_token(principal_id:str,body:TokenInput,user=Depends(current)):
        return iam.create_token(user,principal_id,body)

    @app.delete('/iam/principals/{principal_id}/tokens/{key_id}')
    def revoke_token(principal_id:str,key_id:str,user=Depends(current)):
        return iam.revoke_token(user,principal_id,key_id)
    return iam
