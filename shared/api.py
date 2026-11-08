"""Consistent API errors and authenticated remote session introspection."""
from dataclasses import dataclass
import uuid
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordBearer
from shared.repository import NotFound

bearer = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


@dataclass
class Principal:
    id: str
    username: str
    role: str
    token: str = ""


def application(title: str) -> FastAPI:
    app = FastAPI(title=title)

    @app.middleware("http")
    async def request_id(request, call_next):
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse(status_code=error.status_code, content={"error":{"code":str(error.status_code), "message":str(error.detail), "request_id":getattr(request.state,"request_id","")}}, headers=error.headers)

    @app.exception_handler(NotFound)
    async def not_found(request, error):
        return await http_error(request, HTTPException(404, str(error)))

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        return await http_error(request, HTTPException(422, "Request fields are invalid."))

    @app.exception_handler(Exception)
    async def unknown_error(request, error):
        # Database/provider exceptions can contain credentials; do not echo them.
        return await http_error(request, HTTPException(500, "Request failed. Check service configuration and retry."))

    @app.get("/health")
    def health():
        return {"status":"ok"}

    return app


def remote_auth(auth_url: str):
    async def current(token: str = Depends(bearer)):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f"{auth_url}/session", headers={"Authorization":f"Bearer {token}"})
            if response.status_code != 200:
                raise HTTPException(401, "Invalid or expired session.")
            user = response.json()
            return Principal(user["id"], user["username"], user["role"], token)
        except httpx.RequestError:
            raise HTTPException(503, "Authentication service is unavailable.") from None
    return current


def require_admin(principal: Principal) -> Principal:
    if principal.role != "admin":
        raise HTTPException(403, "Administrator role required.")
    return principal
