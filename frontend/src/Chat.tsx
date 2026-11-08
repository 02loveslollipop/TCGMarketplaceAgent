import {useEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Container,ExpandableSection,FormField,Header,PromptInput,Select,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import {api,stream} from './client';
import type {AgentEvent,Conversation,Decision,Model,Question} from './contracts';
import {CardResults,BudgetResults} from './Results';
import {DecisionPanel} from './DecisionPanel';

type TranscriptEvent=AgentEvent|{type:'user';data:{text:string}};

export function Chat({token}:{token:string}) {
  const [models,setModels]=useState<Model[]>([]),[modelId,setModelId]=useState(''),[text,setText]=useState('');
  const [events,setEvents]=useState<TranscriptEvent[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [question,setQuestion]=useState<Question|null>(null),[execution,setExecution]=useState(''),[conversation,setConversation]=useState<string|undefined>();
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    void api<Model[]>('/api/chat/models',token).then(items=>{setModels(items);setModelId(items[0]?.id||'');}).catch(error=>setError(error.message));
    void api<Conversation[]>('/api/chat/conversations',token).then(setConversations).catch(error=>setError(error.message));
    return ()=>controller.current?.abort();
  },[token]);
  function receive(event:AgentEvent) {
    if(event.type==='execution') {setExecution(event.data.id);setConversation(event.data.conversation_id);}
    if(event.type==='question') setQuestion(event.data);
    if(event.type==='error') setError(event.data.message);
    setEvents(previous=>[...previous,event]);
  }
  async function run(path:string,body:unknown) {
    setError('');setBusy(true);setQuestion(null);
    controller.current=new AbortController();
    try {await stream(path,token,body,receive,controller.current.signal);}
    catch(error) {if((error as Error).name!=='AbortError')setError((error as Error).message);}
    finally {setBusy(false);void api<Conversation[]>('/api/chat/conversations',token).then(setConversations).catch(error=>setError(error.message));}
  }
  function send() {if(!text.trim()||busy||!modelId||question)return;setEvents(previous=>[...previous,{type:'user',data:{text}}]);void run('/api/chat/executions',{text,model_id:modelId,conversation_id:conversation});setText('');}
  function decide(decision:Decision) {setEvents(previous=>[...previous,{type:'user',data:{text:decision.text||decision.action}}]);void run(`/api/chat/executions/${execution}/resume`,decision);}
  async function load(id:string) {
    setConversation(id);setEvents([]);setQuestion(null);
    const history=await api<{role:string;content:{text?:string;type?:string;data?:unknown;execution_id?:string}}[]>(`/api/chat/conversations/${id}`,token);
    const restored=history.flatMap(row=>row.role==='user'&&row.content.text?[{type:'user',data:{text:row.content.text}} as TranscriptEvent]:row.role==='assistant'&&row.content.type?[{type:row.content.type,data:row.content.data} as TranscriptEvent]:[]);
    setEvents(restored);
    const last=history.at(-1);
    if(last?.content.type==='question'&&last.content.execution_id) {
      const execution=await api<{status:string}>(`/api/chat/executions/${last.content.execution_id}`,token);
      if(execution.status==='waiting'){setQuestion(last.content.data as Question);setExecution(last.content.execution_id);}
    }
  }
  return <SpaceBetween size="l">
    <Header variant="h1" description="Research decks, verify card printings and compare sourced quotations." actions={<Button data-testid="new-conversation-button" disabled={busy} onClick={()=>{setConversation(undefined);setEvents([]);setQuestion(null);}}>New conversation</Button>}>Pokémon deck agent</Header>
    {error&&<Alert data-testid="chat-error" type="error">{error}</Alert>}
    <SpaceBetween direction="horizontal" size="m">
      <FormField label="Model"><Select data-testid="model-select" disabled={busy} selectedOption={models.find(model=>model.id===modelId)?{label:models.find(model=>model.id===modelId)!.label,value:modelId}:null} options={models.map(model=>({label:model.label,value:model.id,description:`${model.provider} · ${model.api_id}`}))} onChange={({detail})=>setModelId(detail.selectedOption.value||'')} placeholder="An administrator must enable a model"/></FormField>
      <FormField label="Conversation history"><Select data-testid="conversation-select" disabled={busy} selectedOption={conversation?{label:conversations.find(row=>row.id===conversation)?.title||'Current conversation',value:conversation}:null} options={conversations.map(row=>({label:row.title,value:row.id}))} onChange={({detail})=>{void load(detail.selectedOption.value!).catch(error=>setError(error.message));}} placeholder="Select a conversation"/></FormField>
    </SpaceBetween>
    <Container header={<Header variant="h2">Agent activity</Header>}>
      <SpaceBetween size="m">
        {events.map((event,index)=>event.type==='user'?<ChatBubble key={index} type="outgoing" avatar={<Box>You</Box>} ariaLabel={`Your request ${index+1}`}>{event.data.text}</ChatBubble>:event.type==='progress'?<StatusIndicator key={index} type="info">{event.data.message}</StatusIndicator>:event.type==='cards'&&events.slice(index+1).find(item=>item.type==='result'||item.type==='user')?.type!=='result'?<CardResults key={index} {...event.data}/>:event.type==='question'?<ChatBubble key={index} type="incoming" avatar={<Box>Agent</Box>} ariaLabel="Agent question">{event.data.question}</ChatBubble>:event.type==='result'?<ChatBubble key={index} type="incoming" avatar={<Box>Agent</Box>} ariaLabel="Agent budget result" stretch><BudgetResults result={event.data}/></ChatBubble>:null)}
        {busy&&<StatusIndicator type="loading">Agent is working</StatusIndicator>}
        {!events.length&&<Box>Describe your deck or cards, including format and any printing, language or condition preferences.</Box>}
      </SpaceBetween>
    </Container>
    {question&&<DecisionPanel key={events.length} question={question} onDecision={decide} busy={busy}/>}
    <PromptInput data-testid="chat-prompt-input" nativeTextareaAttributes={{'data-testid':'chat-prompt-textarea'}} ariaLabel="Purchase request" value={text} onChange={({detail})=>setText(detail.value)} onAction={send} disabled={busy||!!question||!modelId} customPrimaryAction={<Button data-testid="chat-send-button" variant="primary" disabled={!text.trim()||busy||!!question||!modelId} onClick={send}>Send request</Button>} placeholder="Build a deck or find exact cards…"/>
    {busy&&<Button data-testid="chat-cancel-button" onClick={()=>controller.current?.abort()}>Stop execution</Button>}
    <ExpandableSection data-testid="limitations-section" headerText="How budgets are calculated"><Box>Prices are compared within each currency. Unknown shipping stays unknown. Missing cards require your explicit decision. Results retain sources and retrieval dates.</Box></ExpandableSection>
  </SpaceBetween>;
}
