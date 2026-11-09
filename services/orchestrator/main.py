import os
from shared.api import remote_auth
from shared.runtime import repository
from services.orchestrator.agent import DeckAgent
from services.orchestrator.app import create_app
from services.orchestrator.models import GuardedModel, model_for
from services.orchestrator.planner import Planner
from services.orchestrator.research import Research
from services.orchestrator.suppliers import Suppliers

repo = repository()


def agent_factory(policy):
    suppliers = Suppliers(api_key=os.getenv("APIFY_API_KEY") or os.getenv("APIFY_TOKEN", ""))
    return DeckAgent(repo, Planner(GuardedModel(model_for(policy), repo, policy, require_context=True), Research(repo)), suppliers)



app = create_app(repo,remote_auth(os.getenv("AUTH_URL","http://auth:8000")),agent_factory)
