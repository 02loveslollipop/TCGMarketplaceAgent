import httpx
from fastapi import Depends, HTTPException, Request, Response, Query
from pydantic import BaseModel, Field, HttpUrl, model_validator
from decimal import Decimal
from typing import Literal
from shared.api import application, require_permission, has_permission
from shared.contracts import utcnow
from services.auth.app import AccountInput, RoleInput
from shared.role_policy import RolePolicies, PolicyError


class RolePolicyInput(BaseModel):
    daily_token_limit: int = Field(ge=0,le=1_000_000_000,strict=True)
    allowed_model_ids: list[str] | None = Field(default=None,max_length=100)


class ModelInput(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    provider: str = Field(pattern=r"^(openai|mistral)$")
    api_id: str = Field(min_length=1,max_length=160,pattern=r"^[A-Za-z0-9_.:-]+$")
    enabled: bool


class PricingInput(BaseModel):
    currency: Literal['USD']='USD'
    input_per_million: Decimal|None=Field(default=None,ge=0,le=1_000_000,allow_inf_nan=False)
    output_per_million: Decimal|None=Field(default=None,ge=0,le=1_000_000,allow_inf_nan=False)
    source_url: HttpUrl|None=None
    note: str=Field(default='',max_length=500)
    @model_validator(mode='after')
    def valid_rates(self):
        if (self.input_per_million is None)!=(self.output_per_million is None):raise ValueError('Provide both token rates or leave both unset.')
        if self.source_url and self.source_url.scheme!='https':raise ValueError('Use an HTTPS pricing reference.')
        if self.source_url:
            from urllib.parse import parse_qs
            if self.source_url.username or self.source_url.password or any(key.lower() in {'key','token','api_key','access_token','signature','authorization'} for key in parse_qs(self.source_url.query or '')):
                raise ValueError('Use a public pricing reference without embedded credentials.')
        if self.input_per_million is not None and not self.source_url and not self.note.strip():raise ValueError('Provide a pricing reference or a rate description.')
        return self


def serialize_model(model):
    return {"id":model.id, "label":model.label, "provider":model.provider, "api_id":model.api_id,
            "enabled":model.enabled, "verified_at":model.verified_at.isoformat() if model.verified_at else None}


def create_app(repo, current, auth_url="http://auth:8000", orchestrator_url="http://orchestrator:8000", client=None):
    app = application("Pokemon administration")

    async def proxy(method, url, user, body=None):
        try:
            if client:
                response = await client.request(method,url,json=body,headers={"Authorization":f"Bearer {user.token}"})
            else:
                async with httpx.AsyncClient(timeout=30) as http:
                    response = await http.request(method,url,json=body,headers={"Authorization":f"Bearer {user.token}"})
            if response.status_code >= 400:
                try:message=response.json().get("error",{}).get("message")
                except ValueError:message=None
                raise HTTPException(response.status_code,message or "Service rejected the administrative operation.")
            return response.json()
        except httpx.RequestError:
            raise HTTPException(503,"Required service is unavailable.") from None

    @app.get("/accounts")
    async def accounts(user=Depends(current)):
        require_permission(user,'admin:accounts:read')
        return await proxy("GET",f"{auth_url}/accounts",user)

    @app.post("/accounts",status_code=201)
    async def create_account(body: AccountInput,user=Depends(current)):
        require_permission(user,'admin:accounts:write')
        return await proxy("POST",f"{auth_url}/accounts",user,body.model_dump())

    @app.put("/accounts/{user_id}/role")
    async def change_role(user_id: str,body: RoleInput,user=Depends(current)):
        require_permission(user,'admin:accounts:write','account:'+user_id)
        return await proxy("PUT",f"{auth_url}/accounts/{user_id}/role",user,body.model_dump())

    @app.get("/role-policies")
    def role_policies(user=Depends(current)):
        require_permission(user,'iam:roles:read')
        return RolePolicies(repo).policies()

    @app.put("/role-policies/{role}")
    def save_role_policy(role: str,body: RolePolicyInput,user=Depends(current)):
        require_permission(user,'iam:roles:write')
        if body.allowed_model_ids is not None and any(not repo.model(model_id) for model_id in body.allowed_model_ids):
            raise HTTPException(422,"Choose models that exist in the model registry.")
        try:return RolePolicies(repo).save(role,body.daily_token_limit,body.allowed_model_ids,user.id)
        except PolicyError as error:raise HTTPException(error.status,str(error)) from None

    @app.get("/models")
    def models(user=Depends(current)):
        require_permission(user,'admin:models:read')
        return [serialize_model(model) for model in repo.models()]

    @app.get('/model-pricing')
    def model_pricing(user=Depends(current)):
        from shared.consumption import pricing_view
        require_permission(user,'admin:models:read')
        return pricing_view(repo)

    @app.put('/model-pricing/{model_id}')
    def update_pricing(model_id:str,body:PricingInput,user=Depends(current)):
        from shared.consumption import save_pricing
        require_permission(user,'admin:models:write','model:'+model_id)
        try:return save_pricing(repo,model_id,body.model_dump(mode='json'),user.id)
        except ValueError as error:raise HTTPException(422,str(error)) from None

    @app.get('/consumption')
    async def consumption(start:str|None=None,end:str|None=None,principal_id:str|None=None,role_id:str|None=None,model_id:str|None=None,user=Depends(current)):
        from urllib.parse import urlencode
        from shared.consumption import bucket,finish_bucket
        from shared.role_policy import read_policy
        require_permission(user,'admin:usage:read')
        params={k:v for k,v in {'start':start,'end':end,'principal_id':principal_id,'role_id':role_id,'model_id':model_id}.items() if v}
        data=await proxy('GET',f'{orchestrator_url}/internal/consumption?'+urlencode(params),user)
        profiles={};warnings=[]
        for path,action,kind in [('/accounts','admin:accounts:read','user'),('/iam/principals','iam:principals:read','api')]:
            if not has_permission(user,action):continue
            try:
                for profile in await proxy('GET',auth_url+path,user):profiles[profile['id']]={**profile,'principal_type':kind}
            except HTTPException:warnings.append('Some current principal names and quotas could not be retrieved. Recorded historical usage remains available.')
        rows={row['id']:row for row in data['principals']}
        if not role_id and not model_id:
            for pid,profile in profiles.items():
                if not principal_id or principal_id==pid:rows.setdefault(pid,finish_bucket(bucket(pid,profile.get('username',profile.get('name',pid)))))
        with repo.transaction() as session:
            for pid,row in rows.items():
                profile=profiles.get(pid)
                row.update(data.get('current_daily',{}).get(pid,{'today_tokens':0,'in_progress':False,'unverified_usage':False}))
                row.update(current_role_name=None,daily_token_limit=None,quota_known=False)
                if profile:
                    row['name']=profile.get('username',profile.get('name',pid));row['principal_type']=profile['principal_type']
                    row['active']=profile.get('active',True)
                    current_role=profile.get('role_id') if profile['principal_type']=='api' else profile.get('iam_role_id') or profile.get('role')
                    try:
                        policy=read_policy(session,current_role);row.update(current_role_name=policy['role_name'],daily_token_limit=policy['daily_token_limit'],quota_known=True)
                    except PolicyError:pass
        data['principals']=sorted(rows.values(),key=lambda row:-row['total_tokens'])
        data.pop('current_daily',None);data['metadata_warnings']=list(dict.fromkeys(warnings))
        return data

    @app.put("/models/{model_id}")
    async def save_model(model_id: str,body: ModelInput,user=Depends(current)):
        require_permission(user,'admin:models:write','model:'+model_id)
        if len(model_id)>160:
            raise HTTPException(422,"Model identifier is too long.")
        verified_at = None
        if body.enabled:
            verification = await proxy("POST",f"{orchestrator_url}/internal/models/verify",user,{"provider":body.provider,"api_id":body.api_id,"model_id":model_id})
            if not verification.get("available"):
                raise HTTPException(422,"Provider did not confirm that API model ID; it remains disabled.")
            verified_at = utcnow()
        model = repo.save_model(model_id,**body.model_dump(),verified_at=verified_at)
        return serialize_model(model)

    @app.get("/legality/status")
    async def legality_status(user=Depends(current)):
        require_permission(user,'admin:legality:read')
        return await proxy("GET", f"{orchestrator_url}/internal/legality/status", user)

    @app.post("/legality/refresh")
    async def refresh_legality(user=Depends(current)):
        require_permission(user,'admin:legality:refresh')
        return await proxy("POST", f"{orchestrator_url}/internal/legality/refresh", user)

    @app.get("/activity")
    async def activity(limit:int=Query(default=50,ge=1,le=500),user=Depends(current)):
        require_permission(user,'admin:activity:read')
        return await proxy("GET", f"{orchestrator_url}/internal/activity"+(f'?limit={limit}' if limit!=50 else ''), user)

    @app.get("/activity/{execution_id}")
    async def activity_detail(execution_id: str, user=Depends(current)):
        require_permission(user,'admin:activity:read')
        return await proxy("GET", f"{orchestrator_url}/internal/activity/{execution_id}", user)

    @app.api_route('/iam/{path:path}',methods=['GET','POST','PUT','DELETE'])
    async def iam_proxy(path:str,request:Request,response:Response,user=Depends(current)):
        import re
        uid=r'[0-9a-fA-F-]{36}'
        routes=[
            ('GET',r'catalog|roles','iam:roles:read'),
            ('POST',r'roles','iam:roles:write'),
            ('PUT',rf'roles/{uid}','iam:roles:write'),
            ('DELETE',rf'roles/{uid}','iam:roles:write'),
            ('PUT',rf'accounts/{uid}/role','admin:accounts:write'),
            ('GET',r'principals','iam:principals:read'),
            ('POST',r'principals','iam:principals:write'),
            ('PUT',rf'principals/{uid}','iam:principals:write'),
            ('GET',rf'principals/{uid}/tokens','iam:tokens:read'),
            ('POST',rf'principals/{uid}/tokens','iam:tokens:write'),
            ('DELETE',rf'principals/{uid}/tokens/{uid}','iam:tokens:write'),
        ]
        permission=next((action for method,pattern,action in routes if method==request.method and re.fullmatch(pattern,path)),None)
        if not permission:raise HTTPException(404,'IAM operation not found.')
        resource='*'
        segments=path.split('/')
        if len(segments)>1:
            resource={'roles':'role:','principals':'principal:','accounts':'account:'}.get(segments[0],'')+segments[1]
        require_permission(user,permission,resource)
        try:body=await request.json() if request.method in {'POST','PUT'} else None
        except ValueError:raise HTTPException(422,'Request body must contain valid JSON.') from None
        data=await proxy(request.method,f"{auth_url}/iam/{path}",user,body)
        response.headers['Cache-Control']='no-store'
        if request.method=='POST':response.status_code=201
        return data

    return app

