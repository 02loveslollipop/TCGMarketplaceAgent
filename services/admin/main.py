import os
from shared.api import remote_auth
from shared.runtime import repository
from services.admin.app import create_app
app = create_app(repository(),remote_auth(os.getenv("AUTH_URL","http://auth:8000")))
