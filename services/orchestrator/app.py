import asyncio
from contextlib import suppress
import json
from fastapi import Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from shared.api import application, require_admin
from shared.contracts import ChatInput, Decision
from services.admin.app import serialize_model
from services.orchestrator.models import ModelUnavailable, verify_api_id, invocation_context
from shared.role_policy import RolePolicies, PolicyError


class VerificationInput(BaseModel):
    provider: str = Field(pattern=r"^(openai|mistral)$")
    api_id: str = Field(min_length=1,max_length=160)


def create_app(repo, current, agent_factory, verifier=verify_api_id):
    app = application("Pokemon agent orchestration")

    async def allowed(model_id,user):
        try:RolePolicies(repo).check_available(user.id,user.role,model_id)
        except PolicyError as error:raise HTTPException(error.status,str(error)) from None
        policy = repo.model(model_id)
        if not policy or not policy.enabled:
            raise HTTPException(403,"Model is disabled or unavailable.")
        try:
            if not await verifier(policy.provider,policy.api_id):
                raise HTTPException(422,"Configured API model ID is unavailable; no replacement was selected.")
        except ModelUnavailable as error:
            raise HTTPException(503,str(error)) from None
        return policy

    @app.get("/models")
    def models(user=Depends(current)):
        return [serialize_model(policy) for policy in repo.models(enabled_only=True) if RolePolicies(repo).model_allowed(user.role,policy.id)]

    @app.get("/usage")
    def usage(user=Depends(current)):
        return RolePolicies(repo).usage(user.id,user.role)

    @app.post("/internal/models/verify")
    async def verify_model(body: VerificationInput,user=Depends(current)):
        require_admin(user)
        try:
            return {"available":await verifier(body.provider,body.api_id)}
        except ModelUnavailable as error:
            raise HTTPException(503,str(error)) from None

    @app.get("/conversations")
    def conversations(user=Depends(current)):
        return [{"id":row.id,"title":row.title} for row in repo.conversations(user.id)]

    @app.get("/conversations/{conversation_id}")
    def history(conversation_id: str,user=Depends(current)):
        return [{"role":row.role,"content":row.content,"created_at":row.created_at.isoformat()} for row in repo.history(conversation_id,user.id)]

    @app.get("/executions/{execution_id}")
    def execution(execution_id: str,user=Depends(current)):
        row = repo.execution(execution_id,user.id)
        return {"id":row.id,"conversation_id":row.conversation_id,"status":row.status,"checkpoint":row.checkpoint,
                "events":[{"type":event.kind,"data":event.payload} for event in repo.events(execution_id,user.id)]}

    def stream_response(request, execution, user, agent, **kwargs):
        async def events():
            yield f"event: execution\ndata: {json.dumps({'id':execution.id,'conversation_id':execution.conversation_id})}\n\n"
            iterator = agent.stream(execution.id,user.id,**kwargs).__aiter__()
            pending = None
            context_token=invocation_context.set((user,current))
            try:
                while True:
                    pending = asyncio.create_task(anext(iterator))
                    while not pending.done():
                        done,_ = await asyncio.wait({pending},timeout=10)
                        if not done:
                            if await request.is_disconnected():
                                raise asyncio.CancelledError()
                            yield ": heartbeat\n\n"
                    try:
                        event = pending.result()
                    except StopAsyncIteration:
                        break
                    if event["type"] in {"result","question"}:
                        repo.add_message(execution.conversation_id,user.id,"assistant",{**event,"execution_id":execution.id})
                    yield f"event: {event['type']}\ndata: {json.dumps(event['data'])}\n\n"
            except asyncio.CancelledError:
                repo.checkpoint(execution.id,user.id,{"reason":"client disconnected"},"cancelled")
                raise
            except Exception as error:
                repo.checkpoint(execution.id,user.id,{"error_type":type(error).__name__},"failed")
                repo.event(execution.id,user.id,"error",{"error_type":type(error).__name__})
                message = "Model provider is rate-limited; try again later." if getattr(error,"status_code",None)==429 else f"Execution failed ({type(error).__name__}). Check model/source access and retry."
                if isinstance(error,(PolicyError,ModelUnavailable)):message=str(error)
                yield f"event: error\ndata: {json.dumps({'message':message})}\n\n"
            finally:
                if pending and not pending.done():
                    pending.cancel()
                    with suppress(asyncio.CancelledError):
                        await pending
                try:await iterator.aclose()
                finally:invocation_context.reset(context_token)
        return StreamingResponse(events(),media_type="text/event-stream",headers={"Cache-Control":"no-cache, no-store","X-Accel-Buffering":"no"})

    @app.post("/executions")
    async def start(body: ChatInput,request: Request,user=Depends(current)):
        policy = await allowed(body.model_id,user)
        conversation = repo.conversation(body.conversation_id,user.id) if body.conversation_id else repo.new_conversation(user.id,body.text)
        history = [{"role":row.role,"content":row.content} for row in repo.history(conversation.id,user.id)]
        repo.add_message(conversation.id,user.id,"user",{"text":body.text})
        execution = repo.new_execution(conversation.id,user.id,policy.id)
        return stream_response(request,execution,user,agent_factory(policy),initial={"request":body.text,"history":history})

    @app.post("/executions/{execution_id}/resume")
    async def resume(execution_id: str,body: Decision,request: Request,user=Depends(current)):
        execution = repo.execution(execution_id,user.id)
        if execution.status != "waiting":
            raise HTTPException(409,"Execution is not waiting for an answer.")
        actions = execution.checkpoint.get("actions",[])
        if body.action not in actions or (body.action in {"keep_missing","substitute"} and not body.approved) or (body.action in {"clarify","substitute"} and not body.text.strip()):
            raise HTTPException(422,"Answer the current question and explicitly approve substitutions or missing cards.")
        policy = await allowed(execution.model_id,user)
        if not repo.claim_execution(execution_id,user.id):
            raise HTTPException(409,"Execution is already being resumed.")
        repo.add_message(execution.conversation_id,user.id,"user",{"decision":body.model_dump()})
        return stream_response(request,execution,user,agent_factory(policy),decision=body)

    return app
