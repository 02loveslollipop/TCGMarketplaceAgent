"""Append-only usage and pricing snapshots, using the existing app audit ledger."""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy import select
from shared.contracts import utcnow
from shared.db import AuditLog, DailyTokenUsage
from shared.role_policy import usage_day

UNATTRIBUTED='unattributed'
# Standard text rates checked against official model pages on 2026-11-13.
REFERENCES={
 ('openai','gpt-6-luna'):('0.10','0.50','https://developers.openai.com/api/docs/models/gpt-6-luna'),
 ('openai','gpt-6.1-terra'):('1.00','5.00','https://developers.openai.com/api/docs/models/gpt-6.1-terra'),
}
NOTICE='Indicative standard input/output model cost in USD. Cache adjustments, provider discounts, taxes and external tool fees are excluded. Historical usage without a pricing snapshot is unpriced.'


def price_snapshot(session, model):
    if model is None:return None
    row=session.scalar(select(AuditLog).where(AuditLog.action=='model_pricing_changed',
        AuditLog.details['model_id'].as_string()==model.id).order_by(AuditLog.created_at.desc(),AuditLog.id.desc()).limit(1))
    if row:
        data=row.details
        if data.get('provider')!=model.provider or data.get('api_id')!=model.api_id:return None
        return {**data,'origin':'administrator','updated_at':row.created_at.isoformat()} if data.get('input_per_million') is not None else None
    reference=REFERENCES.get((model.provider,model.api_id))
    if not reference:return None
    return {'model_id':model.id,'provider':model.provider,'api_id':model.api_id,'currency':'USD',
        'input_per_million':reference[0],'output_per_million':reference[1],'source_url':reference[2],
        'checked_at':'2026-11-13','origin':'published_reference','notice':NOTICE}


def estimate(usage, pricing):
    if usage is None or pricing is None:return None
    value=(Decimal(usage['input_tokens'])*Decimal(pricing['input_per_million'])+
           Decimal(usage['output_tokens'])*Decimal(pricing['output_per_million']))/Decimal(1_000_000)
    return str(value.quantize(Decimal('.00000001'),rounding=ROUND_HALF_UP))


def pricing_view(repo):
    with repo.transaction() as session:
        return [{'model_id':model.id,'label':model.label,'provider':model.provider,'api_id':model.api_id,
                 'pricing':price_snapshot(session,model)} for model in repo.models()]


def save_pricing(repo,model_id,body,actor):
    model=repo.model(model_id)
    if model is None:raise ValueError('Unknown model policy.')
    data={**body,'model_id':model_id,'provider':model.provider,'api_id':model.api_id,'actor_id':actor,'notice':NOTICE}
    with repo.transaction() as session:session.add(AuditLog(action='model_pricing_changed',details=data))
    return next(row for row in pricing_view(repo) if row['model_id']==model_id)


def bucket(key,name):
    return {'id':key,'name':name,'input_tokens':0,'output_tokens':0,'total_tokens':0,
            'estimated_cost_usd':None,'priced_tokens':0,'unpriced_tokens':0,'verified_calls':0,
            'rejected_calls':0,'unverified_calls':0,'_cost':Decimal(0)}


def finish_bucket(row):
    result={k:v for k,v in row.items() if not k.startswith('_')}
    result['estimated_cost_usd']=str(row['_cost']) if row['priced_tokens'] else None
    return result


def daily_state(row):
    expired=bool(row.active_call_id and row.active_until and
        (row.active_until.replace(tzinfo=timezone.utc) if row.active_until.tzinfo is None else row.active_until)<=utcnow())
    return {'today_tokens':row.total_tokens,'in_progress':bool(row.active_call_id),'unverified_usage':bool(row.unverified_usage or expired)}


def report(repo,start=None,end=None,principal_id=None,role_id=None,model_id=None):
    today=usage_day();end=end or today;start=start or end-timedelta(days=6)
    if start>end or (end-start).days>89:raise ValueError('Choose an inclusive date range of up to 90 days.')
    with repo.transaction() as session:
        daily=list(session.scalars(select(DailyTokenUsage).where(DailyTokenUsage.usage_date>=start,DailyTokenUsage.usage_date<=end)))
        current=list(session.scalars(select(DailyTokenUsage).where(DailyTokenUsage.usage_date==today)))
        query=select(AuditLog).where(AuditLog.action=='model_usage',AuditLog.details['usage_date'].as_string()>=start.isoformat(),AuditLog.details['usage_date'].as_string()<=end.isoformat()).order_by(AuditLog.created_at,AuditLog.id).limit(100001)
        logs=list(session.scalars(query));truncated=len(logs)>100000;logs=logs[:100000]
        active_ids=[row.active_call_id for row in current if row.active_call_id]
        active_logs=list(session.scalars(select(AuditLog).where(AuditLog.id.in_(active_ids)))) if active_ids else []
    accounted=defaultdict(lambda:{'input_tokens':0,'output_tokens':0});records=[]
    for log in logs:
        r=dict(log.details);records.append(r)
        if r.get('status')=='verified':
            total=accounted[(r['principal_id'],r['usage_date'])]
            for k in total:total[k]+=r.get(k,0)
    # Daily counters are authoritative. Never invent an old role/model/cost.
    for row in daily:
        known=accounted[(row.user_id,row.usage_date.isoformat())]
        residual={key:max(0,getattr(row,key)-known[key]) for key in ['input_tokens','output_tokens']}
        if sum(residual.values()):records.append({**residual,'principal_id':row.user_id,'principal_name':row.user_id,'principal_type':'unknown',
            'role_id':UNATTRIBUTED,'role_name':'Historical role not recorded','model_id':UNATTRIBUTED,
            'usage_date':row.usage_date.isoformat(),'status':'historical','estimated_cost_usd':None})
    def matches(r):
        return (not principal_id or r['principal_id']==principal_id) and (not role_id or r.get('role_id')==role_id) and (not model_id or r.get('model_id')==model_id)
    total=bucket('total','Selected usage');principals={};roles={};models={};days={}
    for offset in range((end-start).days+1):
        day=(start+timedelta(days=offset)).isoformat();days[day]=bucket(day,day)
    for r in filter(matches,records):
        pid=r['principal_id'];rid=r.get('role_id',UNATTRIBUTED);mid=r.get('model_id',UNATTRIBUTED)
        p=principals.setdefault(pid,{**bucket(pid,r.get('principal_name',pid)),'principal_type':r.get('principal_type','unknown')})
        if r.get('principal_type') in {'user','api'}:p['name']=r.get('principal_name',pid);p['principal_type']=r['principal_type']
        role=roles.setdefault(rid,bucket(rid,r.get('role_name',rid)))
        model=models.setdefault(mid,bucket(mid,mid))
        for group in [total,p,role,model,days[r['usage_date']]]:
            ins=r.get('input_tokens',0);outs=r.get('output_tokens',0);tokens=ins+outs
            group['input_tokens']+=ins;group['output_tokens']+=outs;group['total_tokens']+=tokens
            cost=r.get('estimated_cost_usd')
            group['priced_tokens' if cost is not None else 'unpriced_tokens']+=tokens
            if cost is not None:group['_cost']+=Decimal(cost)
            if r['status'] in {'verified','rejected','unverified'}:group[r['status']+'_calls']+=1
    today_map={row.user_id:row for row in current}
    for pid,p in principals.items():
        row=today_map.get(pid);p.update(daily_state(row) if row else {'today_tokens':0,'in_progress':False,'unverified_usage':False})
    return {'start_date':start.isoformat(),'end_date':end.isoformat(),'timezone':'Asia/Tokyo','today':today.isoformat(),
        'summary':finish_bucket(total),'daily':[finish_bucket(row) for row in days.values()],
        'principals':[finish_bucket(p) for p in sorted(principals.values(),key=lambda r:-r['total_tokens'])],
        'roles':[finish_bucket(p) for p in sorted(roles.values(),key=lambda r:-r['total_tokens'])],
        'models':[finish_bucket(p) for p in sorted(models.values(),key=lambda r:-r['total_tokens'])],
        'current_daily':{row.user_id:daily_state(row) for row in current},
        'active_calls':sum(matches(log.details) for log in active_logs),
        'detail_truncated':truncated,'notice':NOTICE,'generated_at':utcnow().isoformat()}


def execution_usage(logs):
    rows=[log.details for log in logs if log.action=='model_usage']
    result=bucket('execution','Execution usage');duration=0;durations=0
    for row in rows:
        tokens=row.get('input_tokens',0)+row.get('output_tokens',0)
        for key in ['input_tokens','output_tokens']:result[key]+=row.get(key,0)
        result['total_tokens']+=tokens
        cost=row.get('estimated_cost_usd');result['priced_tokens' if cost is not None else 'unpriced_tokens']+=tokens
        if cost is not None:result['_cost']+=Decimal(cost)
        if row.get('status') in {'verified','rejected','unverified'}:result[row['status']+'_calls']+=1
        if row.get('started_at') and row.get('finished_at'):
            duration+=max(0,int((datetime.fromisoformat(row['finished_at'])-datetime.fromisoformat(row['started_at'])).total_seconds()*1000));durations+=1
    return {**finish_bucket(result),'recorded':any(row.get('status')=='verified' for row in rows),'model_duration_ms':duration if durations else None}
