"""Provider/API IDs are explicit registry data. There is no model fallback."""
import os
import httpx
from langchain_openai import ChatOpenAI
from langchain_mistralai import ChatMistralAI


class ModelUnavailable(Exception):
    pass


class GuardedModel:
    """Recheck policy before every model call, including research tool rounds."""
    def __init__(self, runnable, repo, policy):
        self.runnable,self.repo,self.policy=runnable,repo,policy

    async def ainvoke(self, messages):
        current=self.repo.model(self.policy.id)
        if not current or not current.enabled or (current.provider,current.api_id)!=(self.policy.provider,self.policy.api_id):
            raise ModelUnavailable("Model policy changed or disabled this model during execution.")
        return await self.runnable.ainvoke(messages)

    def bind_tools(self, tools):
        return GuardedModel(self.runnable.bind_tools(tools),self.repo,self.policy)

    def with_structured_output(self, schema, **options):
        return GuardedModel(self.runnable.with_structured_output(schema,**options),self.repo,self.policy)


def model_for(policy):
    if not policy or not policy.enabled:
        raise ModelUnavailable("Selected model is disabled or unavailable.")
    if policy.provider == "openai":
        key = os.getenv("OPENAI_API_KEY", "")
        if not key:
            raise ModelUnavailable("OpenAI credential is not configured.")
        return ChatOpenAI(model=policy.api_id, api_key=key, timeout=90, max_retries=0)
    if policy.provider == "mistral":
        key = os.getenv("MISTRAL_API_KEY", "")
        if not key:
            raise ModelUnavailable("Mistral credential is not configured.")
        return ChatMistralAI(model=policy.api_id, api_key=key, timeout=90, max_retries=0)
    raise ModelUnavailable("Unsupported model provider.")


async def verify_api_id(provider: str, api_id: str) -> bool:
    urls = {"openai":("https://api.openai.com/v1/models", "OPENAI_API_KEY"),
            "mistral":("https://api.mistral.ai/v1/models", "MISTRAL_API_KEY")}
    if provider not in urls:
        raise ModelUnavailable("Unsupported provider.")
    url, variable = urls[provider]
    key = os.getenv(variable, "")
    if not key:
        raise ModelUnavailable(f"{provider} credential is not configured.")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(url, headers={"Authorization":f"Bearer {key}"})
            response.raise_for_status()
            return any(row["id"] == api_id for row in response.json()["data"])
    except (httpx.HTTPError, KeyError, TypeError):
        raise ModelUnavailable("Provider model verification failed; no model was enabled.") from None
