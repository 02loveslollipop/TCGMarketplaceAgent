from shared.runtime import repository, secret_file
import os
from services.auth.app import create_app
from services.auth.security import Security, Tokens
from services.auth.webauthn import WebAuthn

repo = repository()
tokens = Tokens(secret_file("JWT_PUBLIC_KEY_FILE", "/run/secrets/jwt_public"), secret_file("JWT_PRIVATE_KEY_FILE", "/run/secrets/jwt_private"))
security=Security(repo,tokens,secret_file("TOTP_KEY_FILE","/run/secrets/totp_key").encode(),
                  local_password_only=os.getenv("LOCAL_DEV_PASSWORD_ONLY", "false").strip().lower() == "true")
app = create_app(repo,security,WebAuthn(security,os.getenv("WEBAUTHN_RP_ID","localhost"),os.getenv("WEBAUTHN_ORIGIN","http://localhost:8080")))
