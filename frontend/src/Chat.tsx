import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {Alert,Box,Button,CopyToClipboard,FormField,Header,Icon,List,LiveRegion,Modal,Popover,PromptInput,Select,SpaceBetween,StatusIndicator,TextFilter} from '@cloudscape-design/components';
import type {PromptInputProps} from '@cloudscape-design/components';
import {colorTextBodySecondary,colorTextLabelGenAi,colorTextBodyDefault,fontFamilyBase,fontSizeBodyM,lineHeightBodyM} from '@cloudscape-design/design-tokens';
import {createPortal} from 'react-dom';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import Avatar from '@cloudscape-design/chat-components/avatar';
import SupportPromptGroup from '@cloudscape-design/chat-components/support-prompt-group';
import {api,stream} from './client';
import type {AgentEvent,Conversation,Decision,Model,Question} from './contracts';
import {DecisionPanel} from './DecisionPanel';
import {ArtifactContent,ArtifactPreview,artifactTitle,type ChatArtifact} from './ChatArtifacts';
import './chat.css';
import {ActivityTrace,decisionText,type ChatEntry,type ChatEvent} from './ChatActivity';

interface DailyUsage {daily_token_limit:number;total_tokens:number;remaining_tokens:number;unverified_usage:boolean;in_progress:boolean}
interface HistoryRow {role:string;created_at?:string;content:{text?:string;type?:AgentEvent['type'];data?:unknown;execution_id?:string;decision?:Decision}}
const starters=[
  {id:'deck',label:'Build an M Lucario deck',text:'Help me find an M Lucario deck for Expanded. Use English, near-mint cards and compare supplier prices.'},
  {id:'cards',label:'Find exact card printings',text:'Find prices for <quantity> copies of <card-name>, <set-name> #<card-number>, in <language> and <condition>.'},
  {id:'compare',label:'Compare a deck list',text:'Compare supplier prices for this deck list in <format>. My card list is: <deck-list>'}
];
const agentAvatar=(loading=false)=><Avatar color="gen-ai" iconName="gen-ai" loading={loading} ariaLabel="Deck agent, generative AI assistant" tooltipText="Deck agent"/>;

export function Chat({token,onPreview,navigationContainer,onConversationSelected}:{token:string;onPreview?:(artifact:ChatArtifact|null)=>void;navigationContainer?:HTMLElement|null;onConversationSelected?:()=>void}) {
  const [models,setModels]=useState<Model[]>([]),[modelId,setModelId]=useState(''),[text,setText]=useState(''),[modelNotice,setModelNotice]=useState('');
  const [events,setEvents]=useState<ChatEntry[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[modelsLoading,setModelsLoading]=useState(true),[historyLoading,setHistoryLoading]=useState(false);
  const [question,setQuestion]=useState<Question|null>(null),[execution,setExecution]=useState(''),[conversation,setConversation]=useState<string|undefined>();
  const [conversations,setConversations]=useState<Conversation[]>([]),[conversationsLoading,setConversationsLoading]=useState(true),[historyError,setHistoryError]=useState('');
  const [usage,setUsage]=useState<DailyUsage|null>(null),[usageError,setUsageError]=useState('');
  const [filter,setFilter]=useState(''),[historyCount,setHistoryCount]=useState(15);
  const [localArtifact,setLocalArtifact]=useState<ChatArtifact|null>(null),[jumpVisible,setJumpVisible]=useState(false),[announcement,setAnnouncement]=useState('');
  const controller=useRef<AbortController|null>(null),running=useRef(false),runId=useRef(0),alive=useRef(true),entryId=useRef(0);
  const log=useRef<HTMLDivElement>(null),prompt=useRef<PromptInputProps.Ref>(null),atBottom=useRef(true),previewTrigger=useRef<HTMLElement|null>(null);
  function entry(event:ChatEvent,at?:string):ChatEntry{return {...event,id:`chat-event-${++entryId.current}`,at};}
  function append(event:ChatEvent){const row=entry(event);setEvents(previous=>[...previous,row]);}
  function refreshUsage(){void api<DailyUsage>('/api/chat/usage',token).then(value=>{if(!value||!['daily_token_limit','total_tokens','remaining_tokens'].every(key=>typeof (value as unknown as Record<string,unknown>)[key]==='number'))throw new Error('Invalid usage response');if(alive.current){setUsage(value);setUsageError('');}}).catch(()=>{if(alive.current)setUsageError('Daily usage is unavailable. Limits are still checked by the server.');});}
  async function refreshConversations(){try{const rows=await api<Conversation[]>('/api/chat/conversations',token);if(alive.current){setConversations(rows);setHistoryError('');}}catch(error){if(alive.current)setHistoryError((error as Error).message);}finally{if(alive.current)setConversationsLoading(false);}}
  useEffect(()=>{
    alive.current=true;refreshUsage();void refreshConversations();
    void api<Model[]>('/api/chat/models',token).then(items=>{if(alive.current){setModels(items);setModelId(items[0]?.id||'');}}).catch(error=>{if(alive.current)setError(error.message);}).finally(()=>{if(alive.current)setModelsLoading(false);});
    return ()=>{alive.current=false;controller.current?.abort();};
  },[token]);
  useEffect(()=>{const node=log.current;if(!node)return;if(atBottom.current){node.scrollTop=node.scrollHeight;setJumpVisible(false);}else setJumpVisible(true);},[events,busy,question]);
  function receive(event:AgentEvent){
    if(event.type==='execution'){setExecution(event.data.id);setConversation(event.data.conversation_id);}
    if(event.type==='question'){setQuestion(event.data);setAnnouncement('The agent needs your input. Review the decision above the composer.');}
    if(event.type==='error')setError(event.data.message);
    if(event.type==='cards')setAnnouncement('Deck preview ready. Review the resolved printings and sources.');
    if(event.type==='result')setAnnouncement('Deck and budget ready. Open the preview to review quotations and sources.');
    append(event);
  }
  async function run(path:string,body:unknown,restoreQuestion:Question|null=null){
    if(running.current)return;
    const id=++runId.current;running.current=true;setError('');setBusy(true);setQuestion(null);
    const abort=new AbortController();controller.current=abort;let received=false,terminal=false;
    try{await stream(path,token,body,event=>{if(!alive.current||id!==runId.current||abort.signal.aborted)return;received=true;if(['result','question','done','error'].includes(event.type))terminal=true;receive(event);},abort.signal);
      if(!terminal&&!abort.signal.aborted)throw new Error('The response ended before completion. Review the activity and retry your request.');
    }catch(error){if((error as Error).name!=='AbortError'&&!abort.signal.aborted&&alive.current){setError((error as Error).message);append({type:'error',data:{message:(error as Error).message}});if(restoreQuestion&&!received){setQuestion(restoreQuestion);}}}
    finally{if(alive.current&&id===runId.current){running.current=false;setBusy(false);refreshUsage();void refreshConversations();}}
  }
  const quotaBlocked=!!usage&&(usage.remaining_tokens===0||usage.unverified_usage);
  const locked=busy||historyLoading;
  function send(){if(!text.trim()||running.current||historyLoading||!modelId||question||quotaBlocked)return;const request=text.trim();setAnnouncement('Request sent. The agent is working.');atBottom.current=true;append({type:'user',data:{text:request}});setText('');void run('/api/chat/executions',{text:request,model_id:modelId,conversation_id:conversation});}
  function decide(decision:Decision){if(running.current||historyLoading||!question)return;const current=question;setAnnouncement('Decision submitted. The agent is continuing.');atBottom.current=true;append({type:'user',data:{text:decisionText(decision,current),decision}});void run(`/api/chat/executions/${execution}/resume`,decision,current);prompt.current?.focus();}
  function stop(){if(!running.current||controller.current?.signal.aborted)return;controller.current?.abort();append({type:'stopped',data:{message:'You stopped this execution.'}});setAnnouncement('Execution stopped. You can edit and reuse the request.');}
  function closePreview(){setLocalArtifact(null);onPreview?.(null);}
  function newConversation(){if(locked)return;setConversation(undefined);setEvents([]);setQuestion(null);setExecution('');setError('');closePreview();atBottom.current=true;setAnnouncement('New conversation started.');onConversationSelected?.();prompt.current?.focus();}
  async function load(id:string){
    if(locked||running.current)return;setHistoryLoading(true);setError('');
    try{
      const history=await api<HistoryRow[]>(`/api/chat/conversations/${id}`,token);let previousQuestion:Question|null=null;
      const restored=history.flatMap(row=>{
        if(row.role==='user'&&row.content.decision)return [entry({type:'user',data:{text:decisionText(row.content.decision,previousQuestion),decision:row.content.decision}},row.created_at)];
        if(row.role==='user'&&row.content.text)return [entry({type:'user',data:{text:row.content.text}},row.created_at)];
        if(row.role==='assistant'&&row.content.type){if(row.content.type==='question')previousQuestion=row.content.data as Question;return [entry({type:row.content.type,data:row.content.data} as AgentEvent,row.created_at)];}
        return [];
      });
      let waitingQuestion:Question|null=null,waitingExecution='';const last=history.at(-1);
      if(last?.content.type==='question'&&last.content.execution_id){const result=await api<{status:string}>(`/api/chat/executions/${last.content.execution_id}`,token);if(result.status==='waiting'){waitingQuestion=last.content.data as Question;waitingExecution=last.content.execution_id;}}
      if(!alive.current)return;setConversation(id);setEvents(restored);setQuestion(waitingQuestion);setExecution(waitingExecution);closePreview();atBottom.current=true;setJumpVisible(false);setAnnouncement('Conversation loaded.');onConversationSelected?.();
    }catch(error){setError((error as Error).message);}finally{if(alive.current)setHistoryLoading(false);}
  }
  function openArtifact(artifact:ChatArtifact){previewTrigger.current=document.activeElement as HTMLElement;if(onPreview)onPreview(artifact);else setLocalArtifact(artifact);}
  function reuse(request:string){if(locked||question)return;setText(request);prompt.current?.focus();setAnnouncement('Request copied to the composer. Review it before sending.');}
  const selectedModel=models.find(model=>model.id===modelId);
  const title=conversation?conversations.find(row=>row.id===conversation)?.title||'Current conversation':'New conversation';
  const filtered=conversations.filter(row=>row.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const lastUser=events.map(event=>event.type).lastIndexOf('user');
  const latestEntries=events.slice(Math.max(0,lastUser));
  const currentActivity=[...latestEntries].reverse().find(event=>event.type==='progress');
  const currentLabel=currentActivity?.data.message||'Generating a response';
  const rootStyle={'--chat-muted':colorTextBodySecondary,'--chat-ai-label':colorTextLabelGenAi,'--chat-text':colorTextBodyDefault,'--chat-font':fontFamilyBase,'--chat-font-size':fontSizeBodyM,'--chat-line-height':lineHeightBodyM} as CSSProperties;
  const history=<div className="chat-nav-section">
    <Header variant="h2" counter={`(${conversations.length})`} actions={<Button data-testid="new-conversation-button" variant="icon" iconName="add-plus" ariaLabel="New conversation" disabled={locked} onClick={newConversation}/>}>Conversations</Header>
    <SpaceBetween size="m">
      <TextFilter filteringText={filter} filteringPlaceholder="Find a conversation" filteringAriaLabel="Find a conversation" onChange={({detail})=>{setFilter(detail.filteringText);setHistoryCount(15);}}/>
      {conversationsLoading?<StatusIndicator type="loading">Loading conversations</StatusIndicator>:historyError?<Alert type="error" header="History unavailable" action={<Button onClick={()=>void refreshConversations()}>Retry history</Button>}>{historyError}</Alert>:<div>
        <List ariaLabel="Saved conversations" items={filtered.slice(0,historyCount)} renderItem={row=>({id:row.id,content:<Button variant="inline-link" disabled={locked} nativeButtonAttributes={{'aria-current':row.id===conversation?'page':undefined}} onClick={()=>void load(row.id)}>{row.title}</Button>})}/>
        {!filtered.length&&<Box color="text-body-secondary">{filter?'No matching conversations. Try another search.':'Your conversations will appear here after your first request.'}</Box>}
        {filtered.length>historyCount&&<Button variant="inline-link" onClick={()=>setHistoryCount(count=>count+15)}>View more conversations</Button>}
      </div>}
    </SpaceBetween>
  </div>;
  const navigation=<div className="chat-navigation" data-testid="chat-navigation">
    <Box variant="h2" padding="l">Deck agent</Box>
    <div className="chat-navigation-content">{history}</div>
  </div>;
  const modelControl=<div className="chat-model-control"><Select ariaLabel="Model" data-testid="model-select" disabled={locked} statusType={modelsLoading?'loading':'finished'} loadingText="Loading models" expandToViewport selectedOption={selectedModel?{label:selectedModel.label,value:modelId}:null} options={models.map(model=>({label:model.label,value:model.id,description:model.provider==='openai'?'OpenAI':'Mistral'}))} onChange={({detail})=>{const next=models.find(model=>model.id===detail.selectedOption.value);setModelId(detail.selectedOption.value||'');setModelNotice(`Model changed to ${next?.label}. Your next request will use this model.`);}} placeholder="No enabled models"/></div>;
  const composer=<div className="chat-composer-content">
    {jumpVisible&&<div className="chat-jump"><Button iconName="arrow-down" onClick={()=>{const node=log.current;if(node){node.scrollTop=node.scrollHeight;atBottom.current=true;setJumpVisible(false);}}}>Jump to latest</Button></div>}
    {error&&!events.some(event=>event.type==='error'&&event.data.message===error)&&<Alert data-testid="chat-error" type="error" header="Unable to complete the request" dismissible onDismiss={()=>setError('')}>{error}</Alert>}
    {question&&<div className="chat-decision-dock"><DecisionPanel key={`${execution}-${question.question}`} question={question} onDecision={decide} busy={locked}/></div>}
    {quotaBlocked&&<Alert type="warning">{usage?.unverified_usage?'Token usage could not be verified. Model calls are blocked until the daily reset.':'Your daily token quota is reached. It resets at midnight Japan time.'}</Alert>}
    <FormField stretch constraintText={<div role="status" aria-live="polite" data-testid="active-model-summary" className="chat-model-notice">{modelsLoading?'Loading models…':modelNotice|| (selectedModel?`Active model: ${selectedModel.label}`:'An administrator must enable a model before you can send a request.')}{question&&' · The waiting execution keeps its original model.'}</div>}>
      <PromptInput autoFocus ref={prompt} data-testid="chat-prompt-input" nativeTextareaAttributes={{'data-testid':'chat-prompt-textarea'}} ariaLabel="Purchase request" value={text} onChange={({detail})=>setText(detail.value)} onAction={send} readOnly={locked} customPrimaryAction={busy?<Button variant="icon" iconName="stop-circle" ariaLabel="Stop execution" onClick={stop}/>:undefined} disabled={!busy&&(!!question||!modelId||quotaBlocked)} minRows={2} maxRows={6} i18nStrings={{actionButtonAriaLabel:busy?'Stop execution':'Send request'}} actionButtonIconName={busy?'stop-circle':'send'} disableActionButton={!busy&&(!text.trim()||locked||!!question||!modelId||quotaBlocked)} placeholder="Ask about a deck or exact cards" secondaryActions={<div className="chat-prompt-tools">{modelControl}<Popover header="Daily allowance" content={<SpaceBetween size="s"><Box>{usage?`${usage.total_tokens.toLocaleString()} / ${usage.daily_token_limit.toLocaleString()} tokens used. ${usage.remaining_tokens.toLocaleString()} remaining.`:usageError||'Checking daily allowance.'}</Box><Box>Input + output tokens per user. Resets at midnight Japan time. In-flight responses may finish beyond the remaining balance.</Box></SpaceBetween>}><span>{usage?`${usage.remaining_tokens.toLocaleString()} tokens left`:'Daily allowance'}</span></Popover><Popover header="How budgets are calculated" content="Prices are compared within each currency. Unknown shipping stays unknown. Missing cards require your explicit decision. Results retain sources and retrieval dates."><span>About quotations</span></Popover></div>}/>
    </FormField>
  </div>;
  const hasStarted=events.length>0||historyLoading;
  return <>
    {navigationContainer?createPortal(navigation,navigationContainer):navigationContainer===undefined?<aside aria-label="Chat navigation">{navigation}</aside>:null}
    <div className={`chat-page ${hasStarted?'chat-page-active':'chat-page-landing'}`} style={rootStyle}>
      {!hasStarted?<div className="chat-landing">
        <div className="chat-landing-intro"><Icon name="gen-ai" size="big" variant="link"/><Box variant="h1" textAlign="center">What will you play next?</Box><Box color="text-body-secondary" textAlign="center">Research Pokémon TCG decks, exact printings, and sourced prices.</Box></div>
        {composer}
        <div className="chat-starter-prompts"><SupportPromptGroup alignment="horizontal" ariaLabel="Editable starter prompts" items={starters.map(item=>({id:item.id,text:item.label,iconName:'edit',ariaLabel:`Edit prompt: ${item.label}`}))} onItemClick={({detail})=>reuse(starters.find(item=>item.id===detail.id)!.text)}/></div>
      </div>:<>
        <h1 className="chat-visually-hidden">{title}</h1>
        <div className="chat-fitted"><div ref={log} className="chat-message-log" role="region" aria-label="Chat" tabIndex={0} aria-busy={historyLoading} onScroll={()=>{const node=log.current!;atBottom.current=node.scrollHeight-node.scrollTop-node.clientHeight<60;if(atBottom.current)setJumpVisible(false);}}><div className="chat-messages-inner">
          {historyLoading&&<StatusIndicator type="loading">Loading conversation</StatusIndicator>}
<SpaceBetween size="l">{events.map((event,index)=>{
            const end=events.findIndex((item,i)=>i>index&&item.type==='user');const turn=events.slice(index+1,end<0?events.length:end);
            const date=event.at&&Number.isFinite(Date.parse(event.at))?<time dateTime={event.at} title={event.at}>{new Date(event.at).toLocaleString()}</time>:null;
            if(event.type==='user')return <div id={event.id} key={event.id} tabIndex={-1} className="chat-turn"><div className="chat-user-message"><ChatBubble type="outgoing" align="end" avatar={<Avatar ariaLabel="You" tooltipText="You"/>} ariaLabel={`Your request ${events.slice(0,index+1).filter(item=>item.type==='user').length}`} actions={<SpaceBetween direction="horizontal" size="xs"><CopyToClipboard variant="icon" textToCopy={event.data.text} copyButtonAriaLabel="Copy your request" copySuccessText="Request copied" copyErrorText="Unable to copy"/>{!event.data.decision&&<Button variant="icon" iconName="edit" ariaLabel="Edit and reuse request" disabled={locked||!!question} onClick={()=>reuse(event.data.text)}/>}</SpaceBetween>}><div className="chat-message-text">{event.data.text}</div>{date&&<Box fontSize="body-s" color="text-body-secondary">{date}</Box>}{event.data.decision&&<StatusIndicator type={event.data.decision.action==='cancel'?'stopped':event.data.decision.approved?'success':'info'}>{event.data.decision.action==='cancel'?'Cancelled':event.data.decision.approved?'Approved for the listed cards':'Clarification provided'}</StatusIndicator>}</ChatBubble></div><ActivityTrace key={`${event.id}-${busy&&index===lastUser?'active':'settled'}`} entries={turn} active={busy&&index===lastUser} waiting={!!question&&index===lastUser}/></div>;
            if(event.type==='progress'||event.type==='execution'||event.type==='done')return null;
            if(event.type==='cards'&&events.slice(index+1).find(item=>item.type==='result'||item.type==='user')?.type==='result')return null;
            if(event.type==='cards')return <div id={event.id} key={event.id} tabIndex={-1} className="chat-turn"><ChatBubble type="incoming" avatar={agentAvatar()} ariaLabel="Agent deck preview">I resolved these card printings. Review quantities and variants before continuing.</ChatBubble><ArtifactPreview artifact={{id:event.id,kind:'deck',...event.data}} onOpen={openArtifact}/></div>;
            if(event.type==='result')return <div id={event.id} key={event.id} tabIndex={-1} className="chat-turn"><ChatBubble type="incoming" avatar={agentAvatar()} ariaLabel="Agent budget result" actions={<CopyToClipboard variant="icon" textToCopy={event.data.recommendation} copyButtonAriaLabel="Copy recommendation" copySuccessText="Recommendation copied" copyErrorText="Unable to copy"/>}><div className="chat-ai-label">Deck agent · Generated by AI</div><div className="chat-message-text">{event.data.recommendation||'Your deck and budget are ready for review.'}</div>{date&&<Box fontSize="body-s" color="text-body-secondary">{date}</Box>}</ChatBubble><ArtifactPreview artifact={{id:event.id,kind:'budget',result:event.data}} onOpen={openArtifact}/></div>;
            if(event.type==='question')return <div id={event.id} key={event.id} tabIndex={-1}><ChatBubble type="incoming" avatar={agentAvatar()} ariaLabel="Agent question"><div className="chat-message-text">{event.data.question}</div></ChatBubble></div>;
            if(event.type==='stopped')return <div id={event.id} key={event.id} tabIndex={-1}><StatusIndicator type="stopped">{event.data.message}</StatusIndicator></div>;
            return <div id={event.id} key={event.id} tabIndex={-1}><Alert type="error" header="Request interrupted">{event.data.message}</Alert></div>;
          })}</SpaceBetween>
          {busy&&!question&&<div className="chat-working"><ChatBubble type="incoming" avatar={agentAvatar(true)} ariaLabel="Agent working" showLoadingBar>{currentLabel}</ChatBubble></div>}
        </div></div></div>
        <div className="chat-input">{composer}</div>
      </>}
      <LiveRegion hidden>{announcement}</LiveRegion>
      {localArtifact&&<Modal visible size="max" header={artifactTitle(localArtifact)} closeAriaLabel="Close result preview" onDismiss={()=>{setLocalArtifact(null);previewTrigger.current?.focus();}}><ArtifactContent artifact={localArtifact}/></Modal>}
    </div>
  </>;
}
