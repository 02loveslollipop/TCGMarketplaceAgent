import asyncio
import os
from contextvars import ContextVar
import httpx
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
import duckduckgo_mcp_server.server as ddg_server
from mcp.server.transport_security import TransportSecuritySettings
from shared.url_security import public_https


class PublicHttpsBlockedError(ddg_server.BlockedURLError, ValueError):
    pass


_search_failure=ContextVar('search_failure',default=None)


class PublicSearcher(ddg_server.DuckDuckGoSearcher):
    """Keep blocked/failed searches distinct from a genuine empty result."""
    async def _request(self,data,ctx):
        try:
            status,html=await self._request_httpx(data)
        except httpx.HTTPStatusError as error:
            _search_failure.set(f'Search HTTP {error.response.status_code}; access denied.' if error.response.status_code==403 else f'Search HTTP {error.response.status_code}.')
            raise
        except httpx.TimeoutException:
            _search_failure.set('Search timeout.');raise
        except httpx.HTTPError:
            _search_failure.set('Search network error.');raise
        if status in {202,403} or any(marker in html.casefold() for marker in ['captcha','challenge-form','anomaly-modal']):
            _search_failure.set(f'Search HTTP {status} CAPTCHA/challenge; no bypass attempted.')
            return ''
        return html

    async def search(self,*args,**kwargs):
        context=_search_failure.set(None)
        try:
            rows=await super().search(*args,**kwargs)
            failure=_search_failure.get()
            if failure:raise RuntimeError(failure)
            return rows
        finally:_search_failure.reset(context)


class PublicHttpsWebContentFetcher(ddg_server.WebContentFetcher):
    async def _guard_url(self, url: str) -> None:
        try:
            await asyncio.to_thread(public_https, url)
        except ValueError as exc:
            raise PublicHttpsBlockedError(str(exc)) from exc

    async def fetch_and_parse(
        self,
        url: str,
        ctx,
        start_index: int = 0,
        max_length: int = 8000,
        backend: str | None = None,
        parse_mode: str | None = None,
    ) -> str:
        resolved_url = url
        if ddg_server.is_ref_token(url):
            resolved = self.links.resolve(url)
            if resolved is None:
                return ddg_server._unknown_ref_error(url)
            resolved_url = resolved
        try:
            await self._guard_url(resolved_url)
        except ddg_server.BlockedURLError as exc:
            if ctx is not None:
                await ctx.error(f"Blocked fetch for {resolved_url}: {exc}")
            return (
                f"Error: Refusing to fetch {resolved_url} ({exc}). "
                "Only public HTTPS sources on port 443 are allowed."
            )
        return await super().fetch_and_parse(
            resolved_url,
            ctx,
            start_index=start_index,
            max_length=max_length,
            # A 403/challenge is a retrieval limitation. Never escalate to
            # the library's curl/impersonation fallback after being blocked.
            backend='httpx',
            parse_mode=parse_mode,
        )


search_backend = 'httpx'
fetch_backend = 'httpx'
parse_mode = os.getenv("DDG_PARSE_MODE", "markdown").lower()
ref_url_threshold = int(os.getenv("DDG_REF_URL_THRESHOLD", "0"))

ddg_server.searcher = PublicSearcher(
    backend=search_backend,
    ref_url_threshold=ref_url_threshold,
    safe_search=ddg_server.safe_search,
    link_registry=ddg_server.links,
)
ddg_server.fetcher = PublicHttpsWebContentFetcher(
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
