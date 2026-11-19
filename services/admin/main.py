import os
from shared.api import remote_auth
from shared.runtime import repository
from services.admin.app import create_app
auth_url = os.getenv("AUTH_URL", "http://auth:8000")
app = create_app(
    repository(), remote_auth(auth_url), auth_url=auth_url,
    orchestrator_url=os.getenv("ORCHESTRATOR_URL", "http://orchestrator:8000"),
    tcg_url=os.getenv("TCG_MANAGER_URL", "").rstrip("/"),
)
