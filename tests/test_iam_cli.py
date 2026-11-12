"""Managed credentials and complete JSONL multi-turn state tracking."""
import argparse
import json
import httpx
import pytest
from scripts import agent_cli


def arguments(**overrides):
    return argparse.Namespace(**({'base_url':'http://test','token':'tcg_api_synthetic','token_file':None,'refresh':False,
        'prompt':'Synthetic deck','model':'fixture','jsonl':True,'auto_clarify':'first','approve_deck':True,
        'auto_missing':'keep_missing','assert_cards':1,'assert_offers':True}|overrides))


@pytest.mark.asyncio
async def test_api_token_uses_environment_and_never_attempts_jwt_refresh(monkeypatch):
    monkeypatch.setenv('TCG_API_TOKEN','tcg_api_synthetic')
    async def forbidden(request):raise AssertionError('API credentials must not be exchanged for a JWT')
    async with httpx.AsyncClient(transport=httpx.MockTransport(forbidden)) as client:
        assert await agent_cli.resolve_auth_token(client,'http://test',arguments(token=None,refresh=True))=='tcg_api_synthetic'


@pytest.mark.asyncio
async def test_explicit_token_file_overrides_another_environment_identity(monkeypatch,tmp_path):
    monkeypatch.setenv('TCG_API_TOKEN','tcg_api_other_identity')
    private=tmp_path/'token';private.write_text('tcg_api_requested_identity\n')
    async with httpx.AsyncClient() as client:
        assert await agent_cli.resolve_auth_token(client,'http://test',arguments(token=None,token_file=str(private)))=='tcg_api_requested_identity'
        with pytest.raises(RuntimeError,match='Could not read'):
            await agent_cli.resolve_auth_token(client,'http://test',arguments(token=None,token_file=str(tmp_path/'missing')))


@pytest.mark.asyncio
async def test_jsonl_consumes_question_through_done_and_resumes_correct_execution(monkeypatch,capsys):
    calls=[];finished=[]
    async def events(client,url,payload,headers):
        calls.append(url)
        yield 'execution',{'id':'run-1','conversation_id':'chat-1'}
        if len(calls)==1:
            yield 'question',{'kind':'deck_approval','question':'Approve?'}
            yield 'done',{'status':'waiting'}
        else:
            yield 'result',{'plan':{'cards':[{'quantity':1}]},'offers':[{'id':'quote'}]}
            yield 'done',{'status':'completed'}
        finished.append(url)
    monkeypatch.setattr(agent_cli,'stream_sse',events)
    assert await agent_cli.main_async(arguments())==0
    assert calls==finished==['http://test/api/chat/executions','http://test/api/chat/executions/run-1/resume']
    output=capsys.readouterr()
    assert [json.loads(line)['event'] for line in output.out.splitlines()]==['execution','question','done','execution','result','done']
    assert 'tcg_api_synthetic' not in output.out+output.err
