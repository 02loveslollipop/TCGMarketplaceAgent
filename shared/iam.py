"""Application IAM: inherited inline policies, explicit Deny, and role quotas."""
from fnmatch import fnmatchcase
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from shared.db import IAMRole, RolePolicy

BUILTIN_ROLE_IDS={'user':'00000000-0000-4000-8000-000000000001','admin':'00000000-0000-4000-8000-000000000002'}
DEFAULT_LIMITS={'user':50_000,'admin':200_000}
ACTIONS={
 'agent:models:list':'List available models',
 'agent:models:invoke':'Invoke a model',
 'agent:usage:read':'Read own daily usage',
 'agent:conversations:read':'Read own conversations',
 'agent:conversations:write':'Rename own conversations',
 'agent:conversations:delete':'Delete own conversations',
 'agent:executions:create':'Start agent executions',
 'agent:executions:read':'Read own executions and results',
 'agent:executions:resume':'Resume own executions',
 'agent:preferences:read':'Read own agent preferences and currencies',
 'agent:preferences:write':'Change own agent preferences',
 'account:self:manage':'Manage own sign-in and recovery methods',
 'admin:accounts:read':'List human accounts',
 'admin:accounts:write':'Create human accounts and change their roles',
 'admin:models:read':'Read model policies',
 'admin:models:write':'Change model policies',
 'admin:activity:read':'Inspect execution activity',
 'admin:legality:read':'Read legality sync status',
 'admin:legality:refresh':'Refresh the legality catalog',
 'iam:roles:read':'Read IAM roles and policies',
 'iam:roles:write':'Create and manage IAM roles and policies',
 'iam:roles:assign':'Assign a role to a human account or API principal',
 'iam:principals:read':'Read API principals',
 'iam:principals:write':'Create and manage API principals',
 'iam:tokens:read':'Read API token metadata',
 'iam:tokens:write':'Create and revoke API tokens',
}
AGENT_ACTIONS=[action for action in ACTIONS if action.startswith('agent:')]


class IAMError(Exception):
    def __init__(self,message,status=403):
        super().__init__(message);self.status=status


class PolicyStatement(BaseModel):
    model_config=ConfigDict(extra='forbid')
    effect: Literal['Allow','Deny']
    actions: list[str]=Field(min_length=1,max_length=64)
    resources: list[str]=Field(default_factory=lambda:['*'],min_length=1,max_length=100)

    @field_validator('actions','resources')
    @classmethod
    def bounded_patterns(cls,values,info):
        if any(not isinstance(value,str) or not value or len(value)>200 or any(ch.isspace() for ch in value) or '[' in value or ']' in value or '?' in value for value in values):
            raise ValueError('Use nonempty action/resource patterns of up to 200 characters. Only * wildcards are supported.')
        if info.field_name=='actions' and any(not any(fnmatchcase(action,pattern) for action in ACTIONS) for pattern in values):
            raise ValueError('An action pattern does not match any supported action.')
        return list(dict.fromkeys(values))


class InlinePolicy(BaseModel):
    model_config=ConfigDict(extra='forbid')
    statements: list[PolicyStatement]=Field(default_factory=list,max_length=50)


class RoleInput(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name: str=Field(min_length=1,max_length=80)
    description: str=Field(default='',max_length=500)
    parent_id: str|None=None
    daily_token_limit: int|None=Field(default=None,ge=0,le=1_000_000_000,strict=True)
    policy: InlinePolicy=Field(default_factory=InlinePolicy)

    @field_validator('name')
    @classmethod
    def role_name(cls,value):
        value=value.strip()
        if not value:raise ValueError('A role name is required.')
        return value


def permitted(statements,action,resource='*',*,principal_type='user'):
    # API credentials can never acquire account or administration access,
    # including through assignment of a broad human administrator role.
    if principal_type=='api' and not action.startswith('agent:'):
        return False
    allowed=False
    for statement in statements:
        if (any(fnmatchcase(action,pattern) for pattern in statement.get('actions',[]))
                and any(fnmatchcase(resource,pattern) for pattern in statement.get('resources',[]))):
            if statement.get('effect')=='Deny':return False
            if statement.get('effect')=='Allow':allowed=True
    return allowed


def legacy_policy(role,models=None):
    actions=[action for action in AGENT_ACTIONS if action!='agent:models:invoke']+['account:self:manage']
    if role=='admin':actions += ['admin:*','iam:*']
    statements=[{'effect':'Allow','actions':actions,'resources':['*']}]
    if models is None or models:
        statements.append({'effect':'Allow','actions':['agent:models:invoke'],
                           'resources':['*'] if models is None else ['model:'+model for model in models]})
    return {'statements':statements}


def resolve_role(session,role_id):
    lookup=BUILTIN_ROLE_IDS.get(role_id,role_id)
    role=session.get(IAMRole,lookup)
    if role is None:
        # Compatibility until a pre-existing account is migrated; never use
        # this fallback for an unknown or deleted custom role.
        if role_id not in DEFAULT_LIMITS:raise IAMError('The assigned IAM role is unavailable.')
        old=session.get(RolePolicy,role_id)
        return {'id':role_id,'name':'Administrator' if role_id=='admin' else 'User','parent_id':None,
                'daily_token_limit':old.daily_token_limit if old else DEFAULT_LIMITS[role_id],
                'statements':legacy_policy(role_id,old.allowed_model_ids if old else None)['statements'],
                'inheritance':[]}
    leaf=role;seen=set();statements=[];limit=None;inheritance=[]
    while role is not None:
        if role.id in seen or len(seen)>=64:raise IAMError('The IAM role hierarchy is invalid.')
        seen.add(role.id);inheritance.append({'id':role.id,'name':role.name})
        try:policy=InlinePolicy.model_validate(role.policy)
        except ValueError:raise IAMError('The IAM role policy is invalid.') from None
        statements.extend(statement.model_dump() for statement in policy.statements)
        if limit is None and role.daily_token_limit is not None:limit=role.daily_token_limit
        if role.parent_id:
            role=session.get(IAMRole,role.parent_id)
            if role is None:raise IAMError('An inherited IAM role is unavailable.')
        else:role=None
    return {'id':leaf.id,'name':leaf.name,'parent_id':leaf.parent_id,'statements':statements,
            'daily_token_limit':limit if limit is not None else 0,'inheritance':inheritance}


def role_allows(session,role_id,action,resource='*',*,principal_type='user'):
    return permitted(resolve_role(session,role_id)['statements'],action,resource,principal_type=principal_type)


def lock_role_graph(session):
    # Serialize graph mutations before reading ancestors or locking accounts.
    # Selecting IDs avoids retaining stale role attributes after a lock wait.
    list(session.scalars(select(IAMRole.id).order_by(IAMRole.id).with_for_update()))


def ensure_human_administrator(session):
    from shared.db import User
    users=list(session.scalars(select(User).where(User.active.is_(True)).order_by(User.id).with_for_update()))
    if users and not any(role_allows(session,user.iam_role_id or user.role,'iam:roles:write') for user in users):
        raise IAMError('Keep at least one active human account able to manage IAM roles and policies.',409)
