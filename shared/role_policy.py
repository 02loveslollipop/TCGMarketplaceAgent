"""Application-owned role policies and provider-reported daily usage."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from uuid import uuid4
from sqlalchemy import select
from shared.db import RolePolicy, DailyTokenUsage, AuditLog
from shared.contracts import utcnow

TOKYO=ZoneInfo('Asia/Tokyo')
DEFAULT_LIMITS={'user':50_000,'admin':200_000}

class PolicyError(Exception):
    def __init__(self,message,status=429):
        super().__init__(message)
        self.status=status


def as_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def usage_day(now=None):
    return (now or utcnow()).astimezone(TOKYO).date()


def read_policy(session,role):
    if role not in DEFAULT_LIMITS:
        raise PolicyError('This account role cannot use agent models.',403)
    policy=session.get(RolePolicy,role)
    return {'role':role,'daily_token_limit':policy.daily_token_limit if policy else DEFAULT_LIMITS[role],
            'allowed_model_ids':policy.allowed_model_ids if policy else None,'reset_timezone':'Asia/Tokyo'}


class RolePolicies:
    def __init__(self,repo):self.repo=repo

    def policies(self):
        with self.repo.transaction() as session:
            return [read_policy(session,role) for role in DEFAULT_LIMITS]

    def save(self,role,limit,models,actor):
        with self.repo.transaction() as session:
            if role not in DEFAULT_LIMITS:raise PolicyError('Unknown role.',422)
            row=session.get(RolePolicy,role)
            if row is None:
                row=RolePolicy(role=role);session.add(row)
            row.daily_token_limit=limit;row.allowed_model_ids=models
            session.add(AuditLog(action='role_policy_changed',details={'actor_id':actor,'role':role,'daily_limit':limit,'model_ids':models}))
            session.flush()
            return read_policy(session,role)

    def model_allowed(self,role,model_id):
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            return policy['allowed_model_ids'] is None or model_id in policy['allowed_model_ids']

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
            return {**policy,'usage_date':day.isoformat(),'input_tokens':row.input_tokens if row else 0,
                    'output_tokens':row.output_tokens if row else 0,'total_tokens':used,
                    'remaining_tokens':max(0,policy['daily_token_limit']-used),'reset_at':reset.isoformat(),
                    'in_progress':bool(row and row.active_call_id),
                    'unverified_usage':bool(row and (row.unverified_usage or (row.active_call_id and row.active_until and as_utc(row.active_until)<=now)))}

    def check_available(self,user_id,role,model_id):
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            if policy['allowed_model_ids'] is not None and model_id not in policy['allowed_model_ids']:
                raise PolicyError('This model is not enabled for your role.',403)
            self.check(session.get(DailyTokenUsage,(user_id,usage_day())),policy['daily_token_limit'],utcnow())

    def begin_call(self,user_id,role,model_id):
        now=utcnow();day=usage_day(now);call_id=str(uuid4())
        with self.repo.transaction() as session:
            policy=read_policy(session,role)
            if policy['allowed_model_ids'] is not None and model_id not in policy['allowed_model_ids']:
                raise PolicyError('This model is not enabled for your role.',403)
            # Insert once, then lock the user's daily row before admitting a call.
            if session.bind.dialect.name=='postgresql':
                from sqlalchemy.dialects.postgresql import insert
            else:
                from sqlalchemy.dialects.sqlite import insert
            session.execute(insert(DailyTokenUsage).values(user_id=user_id,usage_date=day).on_conflict_do_nothing(index_elements=['user_id','usage_date']))
            row=session.scalar(select(DailyTokenUsage).where(DailyTokenUsage.user_id==user_id,DailyTokenUsage.usage_date==day).with_for_update())
            self.check(row,policy['daily_token_limit'],now)
            row.active_call_id=call_id;row.active_until=now+timedelta(minutes=3)
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
            row.active_call_id=None;row.active_until=None
