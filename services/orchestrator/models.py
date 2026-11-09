"""Provider/API IDs are explicit registry data. There is no model fallback."""
import os
import asyncio
from contextvars import ContextVar
from langchain_core.callbacks import BaseCallbackHandler
from shared.role_policy import RolePolicies, PolicyError
from services.orchestrator.trace import ReasoningSummaryCallback
import httpx
from langchain_openai import ChatOpenAI
from langchain_mistralai import ChatMistralAI


class ModelUnavailable(Exception):
    pass


_pending_calls=set()

def _finished(task):
    _pending_calls.discard(task)
    if not task.cancelled():task.exception()  # Consume errors if the HTTP client disconnected.

invocation_context=ContextVar("model_invocation_context",default=None)


class TokenUsageCallback(BaseCallbackHandler):
    run_inline=True
    def __init__(self):self.usage=None
    def capture(self,message):
        usage=getattr(message,"usage_metadata",None)
        if not usage or any(type(usage.get(key)) is not int or usage[key]<0 for key in ("input_tokens","output_tokens")):
            return
        if self.usage is None:self.usage={"input_tokens":0,"output_tokens":0}
        for key in self.usage:self.usage[key]+=usage[key]
    def on_llm_end(self,response,**kwargs):
        if response.generations and response.generations[0]:
            self.capture(getattr(response.generations[0][0],"message",None))


class GuardedModel:
    """Recheck role/model authorization and account usage around every LLM call."""
    def __init__(self, runnable, repo, policy, *, require_context=False):
        self.runnable,self.repo,self.policy=runnable,repo,policy
        self.require_context=require_context

    async def ainvoke(self, messages):
        current=self.repo.model(self.policy.id)
        if not current or not current.enabled or (current.provider,current.api_id)!=(self.policy.provider,self.policy.api_id):
            raise ModelUnavailable("Model policy changed or disabled this model during execution.")
        context=invocation_context.get()
        if context is None:
            if self.require_context:raise ModelUnavailable("An authenticated model invocation is required.")
            return await self.runnable.ainvoke(messages)
        principal,authenticate=context
        # Refresh session and role, so a mid-run role change revokes further calls.
        principal=await authenticate(token=principal.token)
        policies=RolePolicies(self.repo)
        ticket=policies.begin_call(principal.id,principal.role,self.policy.id)
        async def invoke_and_account():
            callback=TokenUsageCallback();rejected=False
            try:
                result=await self.runnable.ainvoke(messages,config={"callbacks":[callback,ReasoningSummaryCallback()]})
                if callback.usage is None:callback.capture(result)
            except BaseException as error:
                rejected=getattr(error,"status_code",None) in {400,401,403,404,413,422,429}
                raise
            finally:
                policies.finish_call(principal.id,ticket,callback.usage,rejected=rejected)
            if callback.usage is None:
                raise PolicyError("The provider did not report token usage. Further model calls are blocked until the daily reset.")
            return result
        # Stopping an agent prevents subsequent work, while the one provider call
        # already admitted finishes so its billable usage is not lost.
        task=asyncio.create_task(invoke_and_account())
        _pending_calls.add(task);task.add_done_callback(_finished)
        return await asyncio.shield(task)

    def bind_tools(self, tools):
        return GuardedModel(self.runnable.bind_tools(tools),self.repo,self.policy,require_context=self.require_context)

    def with_structured_output(self, schema, **options):
        return GuardedModel(self.runnable.with_structured_output(schema,**options),self.repo,self.policy,require_context=self.require_context)


def model_for(policy):
    if not policy or not policy.enabled:
        raise ModelUnavailable("Selected model is disabled or unavailable.")
    if policy.provider == "openai":
        key = os.getenv("OPENAI_API_KEY", "")
        if not key:
            raise ModelUnavailable("OpenAI credential is not configured.")
        options={}
        if policy.api_id.startswith(("gpt-5", "gpt-6", "o3", "o4")) and "chat" not in policy.api_id:
            options={"use_responses_api":True,"output_version":"responses/v1","reasoning":{"effort":"medium","summary":"auto"},"include":["reasoning.encrypted_content"],"streaming":True,"stream_usage":True,"store":False}
        return ChatOpenAI(model=policy.api_id, api_key=key, timeout=90, max_retries=0, **options)
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
