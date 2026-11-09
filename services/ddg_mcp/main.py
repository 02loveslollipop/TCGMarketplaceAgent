import os
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
import duckduckgo_mcp_server.server as ddg_server
from mcp.server.transport_security import TransportSecuritySettings

search_backend = os.getenv("DDG_SEARCH_BACKEND", "auto").lower()
fetch_backend = os.getenv("DDG_FETCH_BACKEND", "auto").lower()
parse_mode = os.getenv("DDG_PARSE_MODE", "markdown").lower()
ref_url_threshold = int(os.getenv("DDG_REF_URL_THRESHOLD", "0"))

ddg_server.searcher = ddg_server.DuckDuckGoSearcher(
    backend=search_backend,
    ref_url_threshold=ref_url_threshold,
    safe_search=ddg_server.SAFE_SEARCH_MODE,
    link_registry=ddg_server.links,
)
ddg_server.fetcher = ddg_server.WebContentFetcher(
    backend=fetch_backend,
    allow_private_urls=False,
    parse_mode=parse_mode,
    link_registry=ddg_server.links,
)

transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
http_app = ddg_server.mcp.streamable_http_app(
    host="0.0.0.0",
    streamable_http_path="/mcp",
    transport_security=transport_security,
)


async def health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        token = os.getenv("MCP_AUTH_TOKEN", "").strip()
        if token and request.url.path.startswith("/mcp"):
            auth = request.headers.get("Authorization", "").strip()
            if auth != f"Bearer {token}":
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return await call_next(request)


app = Starlette(
    routes=[
        Route("/health", health, methods=["GET"]),
        Mount("", http_app),
    ],
    middleware=[Middleware(AuthMiddleware)],
    lifespan=http_app.router.lifespan_context,
)
