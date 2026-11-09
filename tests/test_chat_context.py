import base64
import uuid
from io import BytesIO
from types import SimpleNamespace
from PIL import Image
import pytest
from pydantic import ValidationError
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, LLMResult
from fastapi.testclient import TestClient
from shared.contracts import ChatInput
from shared.image_context import ImageContext, MAX_IMAGE_BYTES
from services.orchestrator.context import planning_content
from services.orchestrator.trace import ReasoningSummaryCallback
from services.orchestrator.models import model_for
from services.orchestrator.app import create_app
from tests.test_api import current,verified,headers


def image(name='context.png'):
    out=BytesIO();Image.new('RGB',(4,4),(10,20,30)).save(out,format='PNG')
    return {'name':name,'media_type':'image/png','data_url':'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()}


def test_images_validate_actual_format_and_bounded_context():
    assert ChatInput(model_id='fixture',images=[image()]).images[0].name=='context.png'
    for invalid in [dict(image(),media_type='image/jpeg'),dict(image(),data_url='https://example.com/secret'),dict(image(),data_url='data:image/png;base64,%%%'),dict(image(),data_url='data:image/png;base64,'+base64.b64encode(b'x'*(MAX_IMAGE_BYTES+1)).decode())]:
        with pytest.raises(ValidationError):ImageContext(**invalid)
    with pytest.raises(ValidationError):ChatInput(model_id='fixture',images=[image()]*4)
    with pytest.raises(ValidationError):ChatInput(model_id='fixture',text=' ')
    out=BytesIO();Image.new('RGB',(5000,4100)).save(out,format='PNG')
    with pytest.raises(ValidationError):ImageContext(**dict(image(),data_url='data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()))


def test_images_are_multimodal_and_recent_history_is_bounded():
    old=[{'role':'user','content':{'text':'Prior image','images':[image(str(i)+'.png')]}} for i in range(6)]
    blocks=planning_content('Use these cards',old,[image('new.png')])
    assert len(blocks)==4
    assert 'older_images_omitted' in blocks[0]['text'] and 'data:image' not in blocks[0]['text']
    assert [block['image_url']['url'] for block in blocks[1:]]==[image()['data_url']]*3
    assert 'new.png' in blocks[0]['text'] and '4.png' in blocks[0]['text'] and '5.png' in blocks[0]['text']


def test_reasoning_streams_only_public_summary_blocks(monkeypatch):
    events=[];monkeypatch.setattr('services.orchestrator.trace.event_writer',lambda:events.append)
    callback=ReasoningSummaryCallback()
    chunk=AIMessageChunk(content=[{'type':'reasoning','summary':[{'type':'summary_text','text':'Compare verified printings.'}],'encrypted_content':'NEVER_SHOW'}, {'type':'thinking','thinking':'PRIVATE_TRACE'}])
    callback.on_llm_new_token('',chunk=ChatGenerationChunk(message=chunk))
    callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content=chunk.content))]]))
    assert [event['data']['status'] for event in events]==['loading','complete']
    assert all(event['data']['summary']=='Compare verified printings.' for event in events)
    assert 'NEVER_SHOW' not in str(events) and 'PRIVATE_TRACE' not in str(events)
    callback=ReasoningSummaryCallback();callback.on_llm_new_token('',chunk=ChatGenerationChunk(message=AIMessageChunk(content=[{'type':'thinking','thinking':'PRIVATE_TRACE'}])));callback.on_llm_error(ValueError('secret'))
    assert len(events)==2


def test_openai_reasoning_configuration_preserves_explicit_model(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY','fixture-key')
    model=model_for(SimpleNamespace(enabled=True,provider='openai',api_id='gpt-6-luna'))
    assert model.model_name=='gpt-6-luna' and model.use_responses_api and model.streaming
    assert model.reasoning['summary']=='auto' and not model.store
    legacy=model_for(SimpleNamespace(enabled=True,provider='openai',api_id='gpt-5-chat-latest'))
    assert legacy.reasoning is None and not legacy.streaming


def test_image_and_trace_history_survive_reload_and_require_ownership(repo):
    repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    captured=[]
    class Agent:
        async def stream(self,*args,**kwargs):
            captured.append(kwargs['initial'])
            yield {'type':'thinking','data':{'id':'thought','status':'complete','source':'provider_summary','summary':'Check printings first.'}}
            yield {'type':'tool','data':{'id':'tool','name':'search_cards','status':'complete','input':{'name':'Lucario'},'sources':[]}}
            yield {'type':'done','data':{'status':'complete'}}
    client=TestClient(create_app(repo,current,lambda _:Agent(),verified))
    response=client.post('/executions',headers=headers(),json={'images':[image()], 'model_id':'fixture'})
    assert response.status_code==200 and 'event: thinking' in response.text and 'event: tool' in response.text
    assert captured[0]['images']==[image()]
    conversation=client.get('/conversations',headers=headers()).json()[0]
    rows=client.get('/conversations/'+conversation['id'],headers=headers()).json()
    assert rows[0]['content']['images']==[image()]
    assert [row['content'].get('type') for row in rows[1:]]==['thinking','tool']
    assert client.get('/conversations/'+conversation['id'],headers=headers('other')).status_code==404
    assert client.post('/executions',headers=headers(),json={'images':[dict(image(),data_url='bad')],'model_id':'fixture'}).status_code==422


def test_request_body_limit_rejects_before_parsing(repo):
    client=TestClient(create_app(repo,current,lambda _:None,verified))
    response=client.post('/executions',headers={**headers(),'Content-Type':'application/json'},content=b'x'*(9*1024*1024+1))
    assert response.status_code==413


def test_provider_summaries_flow_through_graph_sse_history_and_usage(repo):
    from langchain_core.outputs import ChatGenerationChunk
    from services.orchestrator.models import GuardedModel
    from services.orchestrator.agent import DeckAgent
    from tests.test_agent import FakePlanner,FakeSuppliers
    policy=repo.save_model('fixture',label='Fixture',provider='openai',api_id='fixture',enabled=True)
    class Runnable:
        async def ainvoke(self,messages,config):
            summary=[{'type':'reasoning','summary':[{'type':'summary_text','text':'Check sourced printing identities.'}],'encrypted_content':'PRIVATE_ENCRYPTED'}]
            chunk=ChatGenerationChunk(message=AIMessageChunk(content=summary))
            message=AIMessage(content=summary,usage_metadata={'input_tokens':7,'output_tokens':5,'total_tokens':12})
            for callback in config['callbacks']:
                callback.on_llm_new_token('',chunk=chunk,run_id=uuid.uuid4())
                callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=message)]]))
            return message
    class Planner(FakePlanner):
        async def resolve(self,request,history,knowledge):
            await GuardedModel(Runnable(),repo,policy,require_context=True).ainvoke([])
            return await super().resolve(request,history,knowledge)
    client=TestClient(create_app(repo,current,lambda _:DeckAgent(repo,Planner(),FakeSuppliers()),verified))
    response=client.post('/executions',headers=headers(),json={'text':'Find Test','model_id':'fixture'})
    assert 'event: thinking' in response.text and 'Check sourced printing identities.' in response.text
    assert 'PRIVATE_ENCRYPTED' not in response.text and 'event: result' in response.text
    conversation=client.get('/conversations',headers=headers()).json()[0]
    history=client.get('/conversations/'+conversation['id'],headers=headers()).json()
    summaries=[row['content']['data'] for row in history if row['content'].get('type')=='thinking']
    assert len(summaries)==1 and summaries[0]['status']=='complete'
    assert client.get('/usage',headers=headers()).json()['total_tokens']==12


def test_tool_trace_omits_sensitive_url_parameters_and_raw_results(monkeypatch):
    from services.orchestrator.trace import tool_start,tool_end
    events=[];monkeypatch.setattr('services.orchestrator.trace.event_writer',lambda:events.append)
    trace,public=tool_start('fetch_public_page',{'url':'https://example.com/?token=PRIVATE_TOKEN','password':'PRIVATE_PASSWORD'})
    tool_end(trace,'fetch_public_page',public,'complete',[{'url':'https://example.com/?key=PRIVATE_KEY','title':'Private'},{'url':'https://example.com/cards','title':'Public evidence'}])
    assert 'PRIVATE_' not in str(events)
    assert events[-1]['data']['sources']==[{'url':'https://example.com/cards','title':'Public evidence'}]


async def test_alternative_guidance_excludes_raw_reasoning_blocks():
    from services.orchestrator.planner import Planner
    from shared.contracts import AgentPlan
    class Model:
        async def ainvoke(self,messages):
            return AIMessage(content=[{'type':'thinking','thinking':'PRIVATE_TRACE'},{'type':'reasoning','summary':[{'type':'summary_text','text':'Internal summary'}]},{'type':'text','text':'A possible substitute needs source verification.'}])
    text=await Planner(Model(),None).alternatives(AgentPlan(),[])
    assert text=='A possible substitute needs source verification.'
