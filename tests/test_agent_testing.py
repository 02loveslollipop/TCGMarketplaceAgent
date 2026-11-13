"""Tests for live harness safeguards without calling a paid model."""
import json
import httpx
import pytest
from scripts.agent_testing import LiveAgentClient,Scenario,AgentTestFailure,scrub


def sse(rows):return ''.join('event: '+kind+'\ndata: '+json.dumps(data)+'\n\n' for kind,data in rows)


async def test_harness_handles_question_then_done_and_cancels_without_research_retry(tmp_path):
    starts=[]
    def handler(request):
        starts.append(request.url.path)
        if request.url.path.endswith('/conversations/chat'):return httpx.Response(200,json={'id':'chat'})
        if request.url.path.endswith('/usage'):return httpx.Response(200,json={'total_tokens':0,'in_progress':False,'unverified_usage':False})
        if request.url.path.endswith('/resume'):return httpx.Response(200,text=sse([('execution',{'id':'run','conversation_id':'chat'}),('done',{'status':'cancelled'})]))
        return httpx.Response(200,text=sse([('execution',{'id':'run','conversation_id':'chat'}),('question',{'kind':'clarification','options':['A','B'],'question':'Choose printing'}),('done',{'status':'waiting'})]))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        agent=LiveAgentClient('tcg_api_synthetic',client=client,artifact_dir=tmp_path)
        result=await agent.run(Scenario('question','Choose a card','question'))
    assert result['status']=='passed' and starts.count('/executions')==1 and starts.count('/executions/run/resume')==1
    assert all('tcg_api_synthetic' not in p.read_text() for p in tmp_path.iterdir())


async def test_harness_never_restarts_a_failed_stream(tmp_path):
    seen=[]
    def handler(request):
        seen.append(request.url.path)
        if request.url.path.endswith('/usage'):return httpx.Response(200,json={'total_tokens':0,'in_progress':False,'unverified_usage':False})
        return httpx.Response(503,text='Service unavailable')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        agent=LiveAgentClient('tcg_api_synthetic',client=client,artifact_dir=tmp_path)
        with pytest.raises(AgentTestFailure,match='no start/resume retry'):await agent.run(Scenario('failed','test'))
    assert seen.count('/executions')==1
    assert json.loads((tmp_path/'failed-report.json').read_text())['status']=='failed'


def test_live_harness_rejects_token_exfiltration_targets_and_scrubs_secrets():
    with pytest.raises(AgentTestFailure,match='only be sent'):
        LiveAgentClient('tcg_api_synthetic',chat_url='https://example.com')
    text=json.dumps(scrub({'authorization':'Bearer abc.def','output':'tcg_api_synthetic.secret','usage':{'total_tokens':123}}))
    assert 'synthetic' not in text and 'abc.def' not in text and '123' in text
