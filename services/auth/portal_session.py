"""Host-only browser session bridge; account authorization still uses bearer JWTs."""
import os
import time
from fastapi import Depends, HTTPException, Request, Response
from services.auth.security import AuthenticationError


def install_portal_sessions(app, security, serialize, current):
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

    @app.post('/portal-session')
    def remember(request:Request,response:Response,user=Depends(current)):
        trusted_origin(request)
        token=request.headers['authorization'][7:]
        claims=security.tokens.read(token)
        name,secure=cookie_settings(request)
        response.set_cookie(name,token,max_age=max(0,int(claims['exp']-time.time())),httponly=True,secure=secure,samesite='strict',path='/')
        response.headers['Cache-Control']='no-store'
        return {'shared_session':True}

    @app.get('/portal-session')
    def restore(request:Request,response:Response):
        trusted_origin(request)
        name,secure=cookie_settings(request)
        token=request.cookies.get(name,'')
        try:
            user=security.current(token)
        except AuthenticationError:
            response.status_code=401
            response.delete_cookie(name,path='/',secure=secure,httponly=True,samesite='strict')
            response.headers['Cache-Control']='no-store'
            return {'error':{'message':'No active portal session.'}}
        response.headers['Cache-Control']='no-store'
        return {'access_token':token,'user':serialize(user)}

    app.state.portal_cookie_settings=cookie_settings
