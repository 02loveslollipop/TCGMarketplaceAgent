import {useEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Container,ExpandableSection,FormField,Header,PromptInput,Select,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import {colorBackgroundLayoutMain} from '@cloudscape-design/design-tokens';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import {api,stream} from './client';
import type {AgentEvent,Conversation,Decision,Model,Question} from './contracts';
import {CardResults,BudgetResults} from './Results';
import {DecisionPanel} from './DecisionPanel';

interface DailyUsage {daily_token_limit:number;total_tokens:number;remaining_tokens:number;unverified_usage:boolean;in_progress:boolean}

type TranscriptEvent=AgentEvent|{type:'user';data:{text:string}};

export function Chat({token}:{token:string}) {
  const [models,setModels]=useState<Model[]>([]),[modelId,setModelId]=useState(''),[text,setText]=useState(''),[modelNotice,setModelNotice]=useState('');
  const [events,setEvents]=useState<TranscriptEvent[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[modelsLoading,setModelsLoading]=useState(true),[historyLoading,setHistoryLoading]=useState(false);
  const [question,setQuestion]=useState<Question|null>(null),[execution,setExecution]=useState(''),[conversation,setConversation]=useState<string|undefined>();
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const [usage,setUsage]=useState<DailyUsage|null>(null),[usageError,setUsageError]=useState('');
  function refreshUsage(){void api<DailyUsage>('/api/chat/usage',token).then(value=>{if(!value||!['daily_token_limit','total_tokens','remaining_tokens'].every(key=>typeof (value as unknown as Record<string,unknown>)[key]==='number'))throw new Error('Invalid usage response');setUsage(value);setUsageError('');}).catch(()=>setUsageError('Daily usage is unavailable. Limits are still checked by the server.'));}
  const quotaBlocked=!!usage&&(usage.remaining_tokens===0||usage.unverified_usage);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    refreshUsage();
    void api<Model[]>('/api/chat/models',token).then(items=>{setModels(items);setModelNotice('');setModelId(items[0]?.id||'');}).catch(error=>setError(error.message)).finally(()=>setModelsLoading(false));
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
    finally {setBusy(false);refreshUsage();void api<Conversation[]>('/api/chat/conversations',token).then(setConversations).catch(error=>setError(error.message));}
  }
  function send() {if(!text.trim()||busy||historyLoading||!modelId||question||quotaBlocked)return;setEvents(previous=>[...previous,{type:'user',data:{text}}]);void run('/api/chat/executions',{text,model_id:modelId,conversation_id:conversation});setText('');}
  function decide(decision:Decision) {setEvents(previous=>[...previous,{type:'user',data:{text:decision.text||decision.action}}]);void run(`/api/chat/executions/${execution}/resume`,decision);}
  async function load(id:string) {
    setHistoryLoading(true);setError('');
    try {
      const history=await api<{role:string;content:{text?:string;type?:string;data?:unknown;execution_id?:string}}[]>(`/api/chat/conversations/${id}`,token);
      const restored=history.flatMap(row=>row.role==='user'&&row.content.text?[{type:'user',data:{text:row.content.text}} as TranscriptEvent]:row.role==='assistant'&&row.content.type?[{type:row.content.type,data:row.content.data} as TranscriptEvent]:[]);
      let waitingQuestion:Question|null=null,waitingExecution='';
      const last=history.at(-1);
      if(last?.content.type==='question'&&last.content.execution_id) {
        const execution=await api<{status:string}>(`/api/chat/executions/${last.content.execution_id}`,token);
        if(execution.status==='waiting'){waitingQuestion=last.content.data as Question;waitingExecution=last.content.execution_id;}
      }
      setConversation(id);setEvents(restored);setQuestion(waitingQuestion);setExecution(waitingExecution);
    } catch(error){setError((error as Error).message);} finally{setHistoryLoading(false);}
  }
  const selectedModel=models.find(model=>model.id===modelId);
  const locked=busy||historyLoading;
  return <SpaceBetween size="l">
    <Header variant="h1" description="Research decks, verify card printings and compare sourced quotations.">Deck agent</Header>
    {error&&<Alert data-testid="chat-error" type="error" header="Unable to complete the request" dismissible onDismiss={()=>setError('')}>{error}</Alert>}
    <Container header={<Header variant="h2" actions={<Button data-testid="new-conversation-button" disabled={locked} onClick={()=>{setConversation(undefined);setEvents([]);setQuestion(null);setError('');}}>New conversation</Button>}>Conversation settings</Header>}>
      <SpaceBetween size="m">
        <div className="chat-controls-grid">
          <FormField label="Model" description={question?'Applies to your next new request. The waiting execution keeps its original model.':'Used for your next request.'}><Select data-testid="model-select" disabled={locked} statusType={modelsLoading?'loading':'finished'} loadingText="Loading models" expandToViewport selectedOption={selectedModel?{label:selectedModel.label,value:modelId}:null} options={models.map(model=>({label:model.label,value:model.id,description:model.provider==='openai'?'OpenAI':'Mistral'}))} onChange={({detail})=>{const next=models.find(model=>model.id===detail.selectedOption.value);setModelId(detail.selectedOption.value||'');setModelNotice(`Model changed to ${next?.label}. Your next request will use this model.`);}} placeholder="No enabled models"/></FormField>
          <FormField label="Conversation history" description="Reopen a previous conversation, or start a new one."><Select data-testid="conversation-select" disabled={locked} expandToViewport selectedOption={conversation?{label:conversations.find(row=>row.id===conversation)?.title||'Current conversation',value:conversation}:null} options={conversations.map(row=>({label:row.title,value:row.id}))} onChange={({detail})=>void load(detail.selectedOption.value!)} empty="No previous conversations" placeholder="New conversation"/></FormField>
        </div>
        {usage&&<Box color="text-body-secondary" fontSize="body-s">Daily tokens: {usage.total_tokens.toLocaleString()} / {usage.daily_token_limit.toLocaleString()} · {usage.remaining_tokens.toLocaleString()} remaining · Resets at midnight Japan time</Box>}
        {usageError&&<Box color="text-body-secondary" fontSize="body-s">{usageError}</Box>}
        {quotaBlocked&&<Alert type="warning">{usage?.unverified_usage?'Token usage could not be verified. Model calls are blocked until the daily reset.':'Your daily token quota is reached. It resets at midnight Japan time.'}</Alert>}
        <div role="status" aria-live="polite" data-testid="active-model-summary"><StatusIndicator type={modelsLoading?'loading':selectedModel?'success':'warning'}>{modelsLoading?'Loading models…':modelNotice|| (selectedModel?`Active model: ${selectedModel.label}`:'An administrator must enable a model before you can send a request.')}</StatusIndicator></div>
      </SpaceBetween>
    </Container>
    <Container header={events.length||locked?<Header variant="h2" info={<StatusIndicator type={locked?'loading':question?'pending':'info'}>{historyLoading?'Loading conversation':busy?'Working':question?'Your input needed':events.length?'Ready for a follow-up':'Ready'}</StatusIndicator>} actions={busy&&<Button data-testid="chat-cancel-button" onClick={()=>controller.current?.abort()}>Stop execution</Button>}>Conversation</Header>:undefined}>
      <SpaceBetween size="m">
        {events.map((event,index)=>event.type==='user'?<ChatBubble key={index} type="outgoing" avatar={<Box>You</Box>} ariaLabel={`Your request ${index+1}`}>{event.data.text}</ChatBubble>:event.type==='progress'?<StatusIndicator key={index} type="info">{event.data.message}</StatusIndicator>:event.type==='cards'&&events.slice(index+1).find(item=>item.type==='result'||item.type==='user')?.type!=='result'?<CardResults key={index} {...event.data}/>:event.type==='question'?<ChatBubble key={index} type="incoming" avatar={<Box>Agent</Box>} ariaLabel="Agent question">{event.data.question}</ChatBubble>:event.type==='result'?<ChatBubble key={index} type="incoming" avatar={<Box>Agent</Box>} ariaLabel="Agent budget result" stretch><BudgetResults result={event.data}/></ChatBubble>:null)}
        {busy&&<StatusIndicator type="loading">Agent is working</StatusIndicator>}
        {!events.length&&!historyLoading&&<div className="chat-empty-state"><SpaceBetween size="m"><Header variant="h2">What are you building?</Header><Box color="text-body-secondary">Describe your deck or cards, including format and any printing, language or condition preferences.</Box><Box fontSize="body-s">For example: “Find cards for an M Lucario deck in Expanded, in English and near mint.”</Box></SpaceBetween></div>}
      </SpaceBetween>
    </Container>
    {question&&<DecisionPanel key={events.length} question={question} onDecision={decide} busy={locked}/>}
    <div className="chat-composer" style={{backgroundColor:colorBackgroundLayoutMain}}><FormField label="Purchase request" description={question?'Answer the agent above to continue.':selectedModel?`Send with ${selectedModel.label}. Prices and availability are checked against supplier sources.`:undefined}><PromptInput data-testid="chat-prompt-input" nativeTextareaAttributes={{'data-testid':'chat-prompt-textarea'}} ariaLabel="Purchase request" value={text} onChange={({detail})=>setText(detail.value)} onAction={send} disabled={locked||!!question||!modelId||quotaBlocked} customPrimaryAction={<Button data-testid="chat-send-button" variant="primary" disabled={!text.trim()||locked||!!question||!modelId||quotaBlocked} onClick={send}>Send request</Button>} placeholder="Build a deck or find exact cards…"/></FormField></div>
    <ExpandableSection data-testid="limitations-section" headerText="How budgets are calculated"><Box>Prices are compared within each currency. Unknown shipping stays unknown. Missing cards require your explicit decision. Results retain sources and retrieval dates.</Box></ExpandableSection>
  </SpaceBetween>;
}
