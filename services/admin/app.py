import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from shared.api import application, require_admin
from shared.contracts import utcnow
from services.auth.app import AccountInput


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
                raise HTTPException(response.status_code, "Service rejected the administrative operation.")
            return response.json()
        except httpx.RequestError:
            raise HTTPException(503,"Required service is unavailable.") from None

    @app.get("/accounts")
    async def accounts(user=Depends(current)):
        require_admin(user)
        return await proxy("GET",f"{auth_url}/accounts",user)

    @app.post("/accounts",status_code=201)
    async def create_account(body: AccountInput,user=Depends(current)):
        require_admin(user)
        return await proxy("POST",f"{auth_url}/accounts",user,body.model_dump())

    @app.get("/models")
    def models(user=Depends(current)):
        require_admin(user)
        return [serialize_model(model) for model in repo.models()]

    @app.put("/models/{model_id}")
    async def save_model(model_id: str,body: ModelInput,user=Depends(current)):
        require_admin(user)
        if len(model_id)>160:
            raise HTTPException(422,"Model identifier is too long.")
        verified_at = None
        if body.enabled:
            verification = await proxy("POST",f"{orchestrator_url}/internal/models/verify",user,{"provider":body.provider,"api_id":body.api_id})
            if not verification.get("available"):
                raise HTTPException(422,"Provider did not confirm that API model ID; it remains disabled.")
            verified_at = utcnow()
        model = repo.save_model(model_id,**body.model_dump(),verified_at=verified_at)
        return serialize_model(model)

    return app
