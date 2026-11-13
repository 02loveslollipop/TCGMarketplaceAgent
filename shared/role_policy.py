"""Application-owned role policies and provider-reported daily usage."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from uuid import uuid4
from sqlalchemy import select
from shared.db import RolePolicy, DailyTokenUsage, AuditLog
from shared.contracts import utcnow
from shared.iam import BUILTIN_ROLE_IDS, DEFAULT_LIMITS, resolve_role, permitted, IAMError

TOKYO=ZoneInfo('Asia/Tokyo')

class PolicyError(Exception):
    def __init__(self,message,status=429):
        super().__init__(message)
        self.status=status


def as_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def usage_day(now=None):
    return (now or utcnow()).astimezone(TOKYO).date()


def read_policy(session,role):
    try:resolved=resolve_role(session,role)
    except IAMError as error:raise PolicyError(str(error),error.status) from None
    from shared.db import ModelPolicy
    builtin_key=next((key for key,value in BUILTIN_ROLE_IDS.items() if resolved['id'] in {key,value}),None)
    allowed=[model.id for model in session.scalars(select(ModelPolicy))
             if permitted(resolved['statements'],'agent:models:invoke','model:'+model.id)]
    return {'role':role,'role_name':resolved['name'],'builtin_key':builtin_key,'daily_token_limit':resolved['daily_token_limit'],
            'allowed_model_ids':allowed,'reset_timezone':'Asia/Tokyo','statements':resolved['statements']}


def public_policy(policy):
    return {key:value for key,value in policy.items() if key!='statements'}


class RolePolicies:
    def __init__(self,repo):self.repo=repo

    def policies(self):
        with self.repo.transaction() as session:
            from shared.db import IAMRole,ModelPolicy
            roles=list(session.scalars(select(IAMRole).order_by(IAMRole.name)))
            if roles:
                return [public_policy(read_policy(session,role.id)) for role in roles]
            return [self._legacy_policy_view(session,role) for role in DEFAULT_LIMITS]

    @staticmethod
    def _legacy_policy_view(session,role):
        from shared.db import IAMRole
        from shared.iam import BUILTIN_ROLE_IDS
        if session.get(IAMRole,BUILTIN_ROLE_IDS[role]):
            from shared.db import ModelPolicy
            policy=read_policy(session,role)
            policy['allowed_model_ids']=[model.id for model in session.scalars(select(ModelPolicy))
                                         if permitted(policy['statements'],'agent:models:invoke','model:'+model.id)]
            return public_policy(policy)
        old=session.get(RolePolicy,role)
        return {'role':role,'daily_token_limit':old.daily_token_limit if old else DEFAULT_LIMITS[role],
                'allowed_model_ids':old.allowed_model_ids if old else None,'reset_timezone':'Asia/Tokyo'}

    def save(self,role,limit,models,actor):
        with self.repo.transaction() as session:
            if role not in DEFAULT_LIMITS:raise PolicyError('Unknown role.',422)
            from shared.db import IAMRole
            from shared.iam import BUILTIN_ROLE_IDS
            if session.get(IAMRole,BUILTIN_ROLE_IDS[role]):
                raise PolicyError('Manage this role through IAM roles and policies.',409)
            row=session.get(RolePolicy,role)
            if row is None:
                row=RolePolicy(role=role);session.add(row)
            row.daily_token_limit=limit;row.allowed_model_ids=models
            session.add(AuditLog(action='role_policy_changed',details={'actor_id':actor,'role':role,'daily_limit':limit,'model_ids':models}))
            session.flush()
            return self._legacy_policy_view(session,role)

    def model_allowed(self,role,model_id):
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            return permitted(policy['statements'],'agent:models:invoke','model:'+model_id)

    @staticmethod
    def check(row,limit,now):
        if row and row.unverified_usage:
            raise PolicyError('Token usage could not be verified. Model calls are blocked until the daily reset.')
        if row and row.active_call_id:
            if row.active_until and as_utc(row.active_until) <= now:
                raise PolicyError('A model call ended without verified usage. Model calls are blocked until the daily reset.')
            raise PolicyError('Another model call is in progress for your account. Wait for it to finish or stop the running request.')
        if row and row.total_tokens>=limit:
            raise PolicyError('Your daily token quota is reached. It resets at midnight Japan time.')
        if limit==0:raise PolicyError('Your role has no daily token allowance.')

    def usage(self,user_id,role,now=None):
        now=now or utcnow();day=usage_day(now)
        reset=datetime.combine(day+timedelta(days=1),datetime.min.time(),TOKYO)
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            row=session.get(DailyTokenUsage,(user_id,day))
            used=row.total_tokens if row else 0
            return {**public_policy(policy),'usage_date':day.isoformat(),'input_tokens':row.input_tokens if row else 0,
                    'output_tokens':row.output_tokens if row else 0,'total_tokens':used,
                    'remaining_tokens':max(0,policy['daily_token_limit']-used),'reset_at':reset.isoformat(),
                    'in_progress':bool(row and row.active_call_id),
                    'unverified_usage':bool(row and (row.unverified_usage or (row.active_call_id and row.active_until and as_utc(row.active_until)<=now)))}

    def check_available(self,user_id,role,model_id):
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            if not permitted(policy['statements'],'agent:models:invoke','model:'+model_id):
                raise PolicyError('This model is not enabled for your role.',403)
            self.check(session.get(DailyTokenUsage,(user_id,usage_day())),policy['daily_token_limit'],utcnow())

    def begin_call(self,user_id,role,model_id,*,principal_name=None,principal_type='user',execution_id=None,expected_provider=None,expected_api_id=None):
        now=utcnow();day=usage_day(now);call_id=str(uuid4())
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            if not permitted(policy['statements'],'agent:models:invoke','model:'+model_id):
                raise PolicyError('This model is not enabled for your role.',403)
            from shared.db import ModelPolicy
            model=session.get(ModelPolicy,model_id)
            if expected_provider is not None and (model is None or not model.enabled or (model.provider,model.api_id)!=(expected_provider,expected_api_id)):
                raise PolicyError('Model policy changed before call admission. No model call was started.',503)
            # Insert once, then lock the user's daily row before admitting a call.
            if session.bind.dialect.name=='postgresql':
                from sqlalchemy.dialects.postgresql import insert
            else:
                from sqlalchemy.dialects.sqlite import insert
            session.execute(insert(DailyTokenUsage).values(user_id=user_id,usage_date=day).on_conflict_do_nothing(index_elements=['user_id','usage_date']))
            row=session.scalar(select(DailyTokenUsage).where(DailyTokenUsage.user_id==user_id,DailyTokenUsage.usage_date==day).with_for_update())
            self.check(row,policy['daily_token_limit'],now)
            row.active_call_id=call_id;row.active_until=now+timedelta(minutes=3)
            from shared.consumption import price_snapshot
            session.add(AuditLog(id=call_id,execution_id=execution_id,action='model_call_started',details={
                'call_id':call_id,'principal_id':user_id,'principal_name':principal_name or user_id,'principal_type':principal_type,
                'role_id':BUILTIN_ROLE_IDS.get(role,role),'role_name':policy.get('role_name',role),
                'daily_token_limit':policy['daily_token_limit'],
                'model_id':model_id,'provider':model.provider if model else None,'api_id':model.api_id if model else None,
                'usage_date':day.isoformat(),'started_at':now.isoformat(),'pricing':price_snapshot(session,model)}))
        return day,call_id

    def finish_call(self,user_id,ticket,usage,*,rejected=False):
        day,call_id=ticket
        with self.repo.transaction() as session:
            row=session.scalar(select(DailyTokenUsage).where(DailyTokenUsage.user_id==user_id,DailyTokenUsage.usage_date==day).with_for_update())
            if not row or row.active_call_id!=call_id:return
            if usage is not None:
                row.input_tokens+=usage['input_tokens'];row.output_tokens+=usage['output_tokens'];row.total_tokens+=usage['input_tokens']+usage['output_tokens']
            elif not rejected:
                row.unverified_usage=True
            from shared.consumption import estimate
            started=session.get(AuditLog,call_id)
            if started:
                snapshot=dict(started.details)
                session.add(AuditLog(execution_id=started.execution_id,action='model_usage',details={**snapshot,
                    'status':'verified' if usage is not None else 'rejected' if rejected else 'unverified',
                    'input_tokens':usage['input_tokens'] if usage else 0,'output_tokens':usage['output_tokens'] if usage else 0,
                    'estimated_cost_usd':estimate(usage,snapshot.get('pricing')),'finished_at':utcnow().isoformat()}))
            row.active_call_id=None;row.active_until=None
