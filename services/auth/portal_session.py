"""Host-only browser session bridge; account authorization still uses bearer JWTs."""
import os
import time
from fastapi import Depends, HTTPException, Request, Response
from services.auth.security import AuthenticationError


def install_portal_sessions(app, security, serialize, current):
    def get_max_age():
        return int(os.getenv("ACCESS_TOKEN_TTL_MINUTES", "480")) * 60

    def cookie_settings(request):
        local=not os.getenv('DYNO') and request.url.hostname in {'localhost','127.0.0.1','testserver'}
        return ('tcg_portal_local' if local else '__Host-tcg_portal',not local)

    def trusted_origin(request):
        origin=request.headers.get('origin')
        allowed={value.strip().rstrip('/') for value in os.getenv('CORS_ORIGINS','').split(',') if value.strip()}
        allowed.add(str(request.base_url).rstrip('/'))
        if origin and origin.rstrip('/') not in allowed:
            raise HTTPException(403,'This portal origin is not allowed.')
        if not origin and request.headers.get('sec-fetch-site')=='cross-site':
            raise HTTPException(403,'Cross-site session access is unavailable.')

    def _extract_token(request: Request, cookie_name: str) -> str:
        cookie_tok = request.cookies.get(cookie_name, '').strip()
        if cookie_tok:
            return cookie_tok
        auth_hdr = request.headers.get('authorization', '').strip()
        if auth_hdr.lower().startswith('bearer '):
            return auth_hdr[7:].strip()
        return ''

    @app.post('/portal-session')
    def remember(request:Request,response:Response,user=Depends(current)):
        trusted_origin(request)
        token=request.headers['authorization'][7:]
        claims=security.tokens.read(token)
        name,secure=cookie_settings(request)
        max_age=max(0,int(claims.get('exp', time.time() + get_max_age())-time.time())) or get_max_age()
        response.set_cookie(name,token,max_age=max_age,httponly=True,secure=secure,samesite='strict',path='/')
        response.headers['Cache-Control']='no-store'
        return {'shared_session':True}

    @app.get('/portal-session')
    def restore(request:Request,response:Response):
        trusted_origin(request)
        name,secure=cookie_settings(request)
        token=_extract_token(request, name)
        if not token:
            response.status_code=401
            response.delete_cookie(name,path='/',secure=secure,httponly=True,samesite='strict')
            response.headers['Cache-Control']='no-store'
            return {'error':{'message':'No active portal session.'}}
        try:
            user=security.current(token)
            claims=security.tokens.read(token)
            fresh_token=security.tokens.issue(user, "access", dev_session=claims.get("dev_session"))
        except AuthenticationError:
            response.status_code=401
            response.delete_cookie(name,path='/',secure=secure,httponly=True,samesite='strict')
            response.headers['Cache-Control']='no-store'
            return {'error':{'message':'No active portal session.'}}
        max_age=get_max_age()
        response.set_cookie(name,fresh_token,max_age=max_age,httponly=True,secure=secure,samesite='strict',path='/')
        response.headers['Cache-Control']='no-store'
        sess_data=serialize(user)
        return {'access_token':fresh_token,'token_type':'bearer','session':sess_data,'user':sess_data}

    @app.post('/refresh')
    def refresh(request:Request,response:Response):
        trusted_origin(request)
        name,secure=cookie_settings(request)
        token=_extract_token(request, name)
        if not token:
            raise HTTPException(401, 'No active session or token to refresh.')
        try:
            user=security.current(token)
            claims=security.tokens.read(token)
            fresh_token=security.tokens.issue(user, "access", dev_session=claims.get("dev_session"))
        except AuthenticationError as e:
            raise HTTPException(401, str(e)) from None
        max_age=get_max_age()
        response.set_cookie(name,fresh_token,max_age=max_age,httponly=True,secure=secure,samesite='strict',path='/')
        response.headers['Cache-Control']='no-store'
        sess_data=serialize(user)
        return {'access_token':fresh_token,'token_type':'bearer','session':sess_data,'user':sess_data}

    app.state.portal_cookie_settings=cookie_settings
