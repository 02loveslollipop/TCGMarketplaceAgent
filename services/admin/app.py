import httpx
from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from shared.api import application, require_permission
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
    async def activity(user=Depends(current)):
        require_permission(user,'admin:activity:read')
        return await proxy("GET", f"{orchestrator_url}/internal/activity", user)

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

