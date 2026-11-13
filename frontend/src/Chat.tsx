import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {Alert,Box,Button,CopyToClipboard,FormField,Header,Icon,Input,List,LiveRegion,Modal,Popover,PromptInput,Select,SpaceBetween,StatusIndicator,TextFilter} from '@cloudscape-design/components';
import type {PromptInputProps} from '@cloudscape-design/components';
import {colorTextBodySecondary,colorTextLabelGenAi,colorTextBodyDefault,fontFamilyBase,fontSizeBodyM,lineHeightBodyM} from '@cloudscape-design/design-tokens';
import {createPortal} from 'react-dom';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import Avatar from '@cloudscape-design/chat-components/avatar';
import SupportPromptGroup from '@cloudscape-design/chat-components/support-prompt-group';
import {api,stream} from './client';
import type {AgentEvent,Conversation,Decision,Model,Question,ImageContext} from './contracts';
import {DecisionPanel} from './DecisionPanel';
import {ArtifactContent,ArtifactPreview,artifactTitle,type ChatArtifact} from './ChatArtifacts';
import './chat.css';
import {ImageAttachments,SentImages,readImage,MAX_IMAGES} from './ChatImages';
import {ThinkingTrace} from './ThinkingTrace';
import {decisionText,type ChatEntry,type ChatEvent} from './ChatActivity';
import {Markdown} from './Markdown';
import {settingsInputAttributes} from './inputSemantics';

interface DailyUsage {daily_token_limit:number;total_tokens:number;remaining_tokens:number;unverified_usage:boolean;in_progress:boolean}
interface HistoryRow {role:string;created_at?:string;content:{images?:ImageContext[];text?:string;type?:AgentEvent['type'];data?:unknown;execution_id?:string;decision?:Decision}}
const starters=[
  {id:'deck',label:'Build an M Lucario deck',text:'Help me find an M Lucario deck for Expanded. Use English, near-mint cards and compare supplier prices.'},
  {id:'cards',label:'Find exact card printings',text:'Find prices for <quantity> copies of <card-name>, <set-name> #<card-number>, in <language> and <condition>.'},
  {id:'compare',label:'Compare a deck list',text:'Compare supplier prices for this deck list in <format>. My card list is: <deck-list>'}
];
const agentAvatar=(loading=false)=><Avatar color="gen-ai" iconName="gen-ai" loading={loading} ariaLabel="Deck agent, generative AI assistant" tooltipText="Deck agent"/>;

export function Chat({token,onPreview,navigationContainer,onConversationSelected}:{token:string;onPreview?:(artifact:ChatArtifact|null)=>void;navigationContainer?:HTMLElement|null;onConversationSelected?:()=>void}) {
  const [images,setImages]=useState<ImageContext[]>([]),[imageError,setImageError]=useState(''),[attaching,setAttaching]=useState(false);
  const imageInput=useRef<HTMLInputElement>(null),readingImages=useRef(false);
  const [models,setModels]=useState<Model[]>([]),[modelId,setModelId]=useState(''),[text,setText]=useState(''),[modelNotice,setModelNotice]=useState('');
  const [events,setEvents]=useState<ChatEntry[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[modelsLoading,setModelsLoading]=useState(true),[historyLoading,setHistoryLoading]=useState(false);
  const [question,setQuestion]=useState<Question|null>(null),[execution,setExecution]=useState(''),[conversation,setConversation]=useState<string|undefined>();
  const [conversations,setConversations]=useState<Conversation[]>([]),[conversationsLoading,setConversationsLoading]=useState(true),[historyError,setHistoryError]=useState('');
  const [usage,setUsage]=useState<DailyUsage|null>(null),[usageError,setUsageError]=useState('');
  const [filter,setFilter]=useState(''),[historyCount,setHistoryCount]=useState(15);
  const [localArtifact,setLocalArtifact]=useState<ChatArtifact|null>(null),[jumpVisible,setJumpVisible]=useState(false),[announcement,setAnnouncement]=useState('');
  const [renameTarget,setRenameTarget]=useState<Conversation|null>(null),[renameTitle,setRenameTitle]=useState(''),[renaming,setRenaming]=useState(false),[renameError,setRenameError]=useState('');
  const [deleteTarget,setDeleteTarget]=useState<Conversation|null>(null),[deleting,setDeleting]=useState(false),[deleteError,setDeleteError]=useState('');
  const controller=useRef<AbortController|null>(null),running=useRef(false),runId=useRef(0),alive=useRef(true),entryId=useRef(0);
  const log=useRef<HTMLDivElement>(null),prompt=useRef<PromptInputProps.Ref>(null),atBottom=useRef(true),previewTrigger=useRef<HTMLElement|null>(null);
  function entry(event:ChatEvent,at?:string):ChatEntry{return {...event,id:`chat-event-${++entryId.current}`,at};}
  function append(event:ChatEvent){const row=entry(event);setEvents(previous=>{if(event.type==='thinking'||event.type==='tool'){const currentTurn=previous.map(item=>item.type).lastIndexOf('user');const existing=previous.findIndex((item,index)=>index>currentTurn&&item.type===event.type&&'id' in item.data&&item.data.id===event.data.id);if(existing>=0)return previous.map((item,index)=>index===existing?{...row,id:item.id}:item);}return [...previous,row];});}
  function refreshUsage(){void api<DailyUsage>('/api/chat/usage',token).then(value=>{if(!value||!['daily_token_limit','total_tokens','remaining_tokens'].every(key=>typeof (value as unknown as Record<string,unknown>)[key]==='number'))throw new Error('Invalid usage response');if(alive.current){setUsage(value);setUsageError('');}}).catch(()=>{if(alive.current)setUsageError('Daily usage is unavailable. Limits are still checked by the server.');});}
  async function refreshConversations(){try{const rows=await api<Conversation[]>('/api/chat/conversations',token);if(alive.current){setConversations(rows);setHistoryError('');}}catch(error){if(alive.current)setHistoryError((error as Error).message);}finally{if(alive.current)setConversationsLoading(false);}}
  useEffect(()=>{
    alive.current=true;
    return ()=>{alive.current=false;controller.current?.abort();};
  },[]);
  useEffect(()=>{
    let active=true;
    refreshUsage();void refreshConversations();
    void api<Model[]>('/api/chat/models',token).then(items=>{if(active){setModels(items);setModelId(previous=>items.some(item=>item.id===previous)?previous:items[0]?.id||'');}}).catch(error=>{if(active)setError(error.message);}).finally(()=>{if(active)setModelsLoading(false);});
    return ()=>{active=false;};
  },[token]);
  useEffect(()=>{const node=log.current;if(!node)return;if(atBottom.current){node.scrollTop=node.scrollHeight;setJumpVisible(false);}else setJumpVisible(true);},[events,busy,question]);
  function receive(event:AgentEvent){
    if(event.type==='execution'){setExecution(event.data.id);setConversation(event.data.conversation_id);}
    if(event.type==='question'){setQuestion(event.data);setAnnouncement('The agent needs your input. Review the decision above the composer.');}
    if(event.type==='error')setError(event.data.message);
    if(event.type==='cards')setAnnouncement(event.data.legality.applicable===false?'Collection candidates ready. Review the researched printings and sources.':'Deck preview ready. Review the resolved printings and sources.');
    if(event.type==='result')setAnnouncement(event.data.collection_summary?'Collection and budget ready. Open the preview to review the selected printings and spending allowance.':'Deck and budget ready. Open the preview to review quotations and sources.');
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
  const locked=busy||historyLoading||attaching;
  async function addImages(files:File[]){
    if(locked||question||readingImages.current)return;
    if(images.length+files.length>MAX_IMAGES){setImageError('Attach up to 3 images per request.');return;}
    readingImages.current=true;setAttaching(true);setImageError('');
    try{const added=await Promise.all(files.map(readImage));if(alive.current){setImages(previous=>[...previous,...added]);setAnnouncement(`${added.length} image attachments added. Review them before sending.`);}}
    catch(error){if(alive.current)setImageError((error as Error).message);}
    finally{readingImages.current=false;if(alive.current)setAttaching(false);}
  }
  function send(){if((!text.trim()&&!images.length)||running.current||historyLoading||attaching||!modelId||question||quotaBlocked)return;const request=text.trim();setAnnouncement('Request sent. The agent is working.');atBottom.current=true;append({type:'user',data:{text:request,images}});setText('');setImages([]);setImageError('');void run('/api/chat/executions',{text:request,images,model_id:modelId,conversation_id:conversation});}
  function decide(decision:Decision){if(running.current||historyLoading||!question)return;const current=question;setAnnouncement('Decision submitted. The agent is continuing.');atBottom.current=true;append({type:'user',data:{text:decisionText(decision,current),decision}});void run(`/api/chat/executions/${execution}/resume`,decision,current);prompt.current?.focus();}
  function stop(){if(!running.current||controller.current?.signal.aborted)return;controller.current?.abort();append({type:'stopped',data:{message:'You stopped this execution.'}});setAnnouncement('Execution stopped. You can edit and reuse the request.');}
  function closePreview(){setLocalArtifact(null);onPreview?.(null);}
  function newConversation(){if(locked)return;setConversation(undefined);setEvents([]);setImages([]);setImageError('');setQuestion(null);setExecution('');setError('');closePreview();atBottom.current=true;setAnnouncement('New conversation started.');onConversationSelected?.();prompt.current?.focus();}
  async function load(id:string){
    if(locked||running.current)return;setHistoryLoading(true);setError('');
    try{
      const history=await api<HistoryRow[]>(`/api/chat/conversations/${id}`,token);let previousQuestion:Question|null=null;
      const restored=history.flatMap(row=>{
        if(row.role==='user'&&row.content.decision)return [entry({type:'user',data:{text:decisionText(row.content.decision,previousQuestion),decision:row.content.decision}},row.created_at)];
        if(row.role==='user'&&(row.content.text||row.content.images?.length))return [entry({type:'user',data:{text:row.content.text||'',images:row.content.images}},row.created_at)];
        if(row.role==='assistant'&&row.content.type){if(row.content.type==='question')previousQuestion=row.content.data as Question;return [entry({type:row.content.type,data:row.content.data} as AgentEvent,row.created_at)];}
        return [];
      });
      const deduplicated: typeof restored = [];
      const turnSeen = new Map<string, number>();
      for (const item of restored) {
        if (item.type === 'user') {
          turnSeen.clear();
          deduplicated.push(item);
          continue;
        }
        if (item.type === 'thinking' || item.type === 'tool') {
          const itemId = (item.data as any)?.id;
          if (itemId) {
            const key = `${item.type}:${itemId}`;
            const prevIdx = turnSeen.get(key);
            if (prevIdx !== undefined) {
              deduplicated[prevIdx] = item;
              continue;
            }
            turnSeen.set(key, deduplicated.length);
          }
        }
        deduplicated.push(item);
      }
      let waitingQuestion:Question|null=null,waitingExecution='';const last=history.at(-1);
      if(last?.content.type==='question'&&last.content.execution_id){const result=await api<{status:string}>(`/api/chat/executions/${last.content.execution_id}`,token);if(result.status==='waiting'){waitingQuestion=last.content.data as Question;waitingExecution=last.content.execution_id;}}
      if(!alive.current)return;setImages([]);setImageError('');setConversation(id);setEvents(deduplicated);setQuestion(waitingQuestion);setExecution(waitingExecution);closePreview();atBottom.current=true;setJumpVisible(false);setAnnouncement('Conversation loaded.');onConversationSelected?.();
    }catch(error){setError((error as Error).message);}finally{if(alive.current)setHistoryLoading(false);}
  }
  async function handleRename(){
    if(!renameTarget||!renameTitle.trim())return;
    setRenaming(true);setRenameError('');
    try{
      const updated=await api<Conversation>(`/api/chat/conversations/${renameTarget.id}`,token,{method:'PUT',body:JSON.stringify({title:renameTitle.trim()})});
      setConversations(previous=>previous.map(item=>item.id===renameTarget.id?{...item,title:updated.title}:item));
      setRenameTarget(null);
    }catch(error){setRenameError((error as Error).message);}finally{setRenaming(false);}
  }
  async function handleDelete(){
    if(!deleteTarget)return;
    setDeleting(true);setDeleteError('');
    try{
      await api<{status:string}>(`/api/chat/conversations/${deleteTarget.id}`,token,{method:'DELETE'});
      const targetId=deleteTarget.id;
      setConversations(previous=>previous.filter(item=>item.id!==targetId));
      if(conversation===targetId)newConversation();
      setDeleteTarget(null);
    }catch(error){setDeleteError((error as Error).message);}finally{setDeleting(false);}
  }
  function openArtifact(artifact:ChatArtifact){previewTrigger.current=document.activeElement as HTMLElement;if(onPreview)onPreview(artifact);else setLocalArtifact(artifact);}
  function reuse(request:string,context:ImageContext[]=[]){if(locked||question)return;setText(request);setImages(context);setImageError('');prompt.current?.focus();setAnnouncement('Request copied to the composer. Review it before sending.');}
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
        <List ariaLabel="Saved conversations" items={filtered.slice(0,historyCount)} renderItem={row=>({id:row.id,content:<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',gap:'8px'}}><div style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}><Button variant="inline-link" disabled={locked} nativeButtonAttributes={{'aria-current':row.id===conversation?'page':undefined}} onClick={()=>void load(row.id)}>{row.title}</Button></div><SpaceBetween direction="horizontal" size="xxs"><Button variant="icon" iconName="edit" ariaLabel={`Rename conversation ${row.title}`} disabled={locked} onClick={event=>{event.stopPropagation();setRenameTarget(row);setRenameTitle(row.title);setRenameError('');}}/><Button variant="icon" iconName="remove" ariaLabel={`Delete conversation ${row.title}`} disabled={locked} onClick={event=>{event.stopPropagation();setDeleteTarget(row);setDeleteError('');}}/></SpaceBetween></div>})}/>
        {!filtered.length&&<Box color="text-body-secondary">{filter?'No matching conversations. Try another search.':'Your conversations will appear here after your first request.'}</Box>}
        {filtered.length>historyCount&&<Button variant="inline-link" onClick={()=>setHistoryCount(count=>count+15)}>View more conversations</Button>}
      </div>}
    </SpaceBetween>
  </div>;
  const navigation=<div className="chat-navigation" data-testid="chat-navigation">
    <Box padding="l"><div className="chat-navigation-heading"><Header variant="h2" actions={<Button variant="icon" iconName="settings" href="#preferences" ariaLabel="Agent preferences"/>}>Deck agent</Header></div></Box>
    <div className="chat-navigation-content">{history}</div>
  </div>;
  const modelControl=<div className="chat-model-control"><Select ariaLabel="Model" data-testid="model-select" disabled={locked} statusType={modelsLoading?'loading':'finished'} loadingText="Loading models" expandToViewport selectedOption={selectedModel?{label:selectedModel.label,value:modelId}:null} options={models.map(model=>({label:model.label,value:model.id,description:model.provider==='openai'?'OpenAI':'Mistral'}))} onChange={({detail})=>{const next=models.find(model=>model.id===detail.selectedOption.value);setModelId(detail.selectedOption.value||'');setModelNotice(`Model changed to ${next?.label}. Your next request will use this model.`);}} placeholder="No enabled models"/></div>;
  const composer=<div className="chat-composer-content">
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="Choose image context" onChange={event=>{void addImages(Array.from(event.target.files||[]));event.target.value='';}}/>
    {imageError&&<Alert type="error" dismissible onDismiss={()=>setImageError('')}>{imageError}</Alert>}
    {attaching&&<StatusIndicator type="loading">Reading image context</StatusIndicator>}
    {jumpVisible&&<div className="chat-jump"><Button iconName="arrow-down" onClick={()=>{const node=log.current;if(node){node.scrollTop=node.scrollHeight;atBottom.current=true;setJumpVisible(false);}}}>Jump to latest</Button></div>}
    {error&&!events.some(event=>event.type==='error'&&event.data.message===error)&&<Alert data-testid="chat-error" type="error" header="Unable to complete the request" dismissible onDismiss={()=>setError('')}>{error}</Alert>}
    {question&&<div className="chat-decision-dock"><DecisionPanel key={`${execution}-${question.question}`} question={question} onDecision={decide} busy={locked}/></div>}
    {quotaBlocked&&<Alert type="warning">{usage?.unverified_usage?'Token usage could not be verified. Model calls are blocked until the daily reset.':'Your daily token quota is reached. It resets at midnight Japan time.'}</Alert>}
    <FormField stretch constraintText={<div role="status" aria-live="polite" data-testid="active-model-summary" className="chat-model-notice">{modelsLoading?'Loading models…':modelNotice|| (selectedModel?`Active model: ${selectedModel.label}`:'An administrator must enable a model before you can send a request.')}{question&&' · The waiting execution keeps its original model.'}</div>}>
      <PromptInput autoFocus ref={prompt} data-testid="chat-prompt-input" nativeTextareaAttributes={{...settingsInputAttributes,'data-testid':'chat-prompt-textarea',onPaste:event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void addImages(files);}}}} ariaLabel="Purchase request" value={text} onChange={({detail})=>setText(detail.value)} onAction={send} readOnly={locked} customPrimaryAction={busy?<Button variant="icon" iconName="stop-circle" ariaLabel="Stop execution" onClick={stop}/>:undefined} disabled={!busy&&(!!question||!modelId||quotaBlocked)} minRows={2} maxRows={6} i18nStrings={{actionButtonAriaLabel:busy?'Stop execution':'Send request'}} actionButtonIconName={busy?'stop-circle':'send'} disableActionButton={!busy&&((!text.trim()&&!images.length)||locked||!!question||!modelId||quotaBlocked)} placeholder="Ask a question or paste an image" secondaryContent={images.length?<ImageAttachments images={images} disabled={locked} onRemove={index=>{setImages(previous=>previous.filter((_,i)=>i!==index));setImageError('');}}/>:undefined} secondaryActions={<div className="chat-prompt-tools"><Button variant="icon" iconName="upload" ariaLabel="Attach images" disabled={locked||!!question||images.length>=MAX_IMAGES} onClick={()=>imageInput.current?.click()}/><Button variant="icon" iconName="settings" href="#preferences" ariaLabel="Agent preferences"/>{modelControl}<Popover header="Daily allowance" content={<SpaceBetween size="s"><Box>{usage?`${usage.total_tokens.toLocaleString()} / ${usage.daily_token_limit.toLocaleString()} tokens used. ${usage.remaining_tokens.toLocaleString()} remaining.`:usageError||'Checking daily allowance.'}</Box><Box>Input + output tokens per user. Resets at midnight Japan time. In-flight responses may finish beyond the remaining balance.</Box></SpaceBetween>}><span>{usage?`${usage.remaining_tokens.toLocaleString()} tokens left`:'Daily allowance'}</span></Popover><Popover header="How budgets are calculated" content="Paste or attach up to 3 PNG, JPEG or WebP images (2 MiB each). Sent images are saved in this conversation and shared with the selected model. The latest 3 images are used as context. Prices are compared within each currency. Unknown shipping stays unknown. Missing cards require your explicit decision. Results retain sources and retrieval dates."><span>Images and quotations</span></Popover></div>}/>
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
            if(event.type==='user')return <div id={event.id} key={event.id} tabIndex={-1} className="chat-turn"><div className="chat-user-message"><ChatBubble type="outgoing" align="end" avatar={<Avatar ariaLabel="You" tooltipText="You"/>} ariaLabel={`Your request ${events.slice(0,index+1).filter(item=>item.type==='user').length}`} actions={<SpaceBetween direction="horizontal" size="xs"><CopyToClipboard variant="icon" textToCopy={event.data.text} copyButtonAriaLabel="Copy your request" copySuccessText="Request copied" copyErrorText="Unable to copy"/>{!event.data.decision&&<Button variant="icon" iconName="edit" ariaLabel="Edit and reuse request" disabled={locked||!!question} onClick={()=>reuse(event.data.text,event.data.images)}/>}</SpaceBetween>}><div className="chat-message-text">{event.data.text}</div><SentImages images={event.data.images||[]}/>{date&&<Box fontSize="body-s" color="text-body-secondary">{date}</Box>}{event.data.decision&&<StatusIndicator type={event.data.decision.action==='cancel'?'stopped':event.data.decision.approved?'success':'info'}>{event.data.decision.action==='cancel'?'Cancelled':event.data.decision.approved?'Approved for the listed cards':'Clarification provided'}</StatusIndicator>}</ChatBubble></div><ThinkingTrace entries={turn} active={busy&&index===lastUser}/></div>;
            if(event.type==='thinking'||event.type==='tool'||event.type==='progress'||event.type==='execution'||event.type==='done')return null;
            if(event.type==='cards'&&events.slice(index+1).find(item=>item.type==='result'||item.type==='user')?.type==='result')return null;
            if(event.type==='cards')return <div id={event.id} key={event.id} tabIndex={-1} className="chat-turn"><ChatBubble type="incoming" avatar={agentAvatar()} ariaLabel="Agent deck preview">I resolved these card printings. Review quantities and variants before continuing.</ChatBubble><ArtifactPreview artifact={{id:event.id,kind:'deck',...event.data}} onOpen={openArtifact}/></div>;
            if(event.type==='result')return <div id={event.id} key={event.id} tabIndex={-1} className="chat-turn"><ChatBubble type="incoming" avatar={agentAvatar()} ariaLabel="Agent budget result" actions={<CopyToClipboard variant="icon" textToCopy={event.data.recommendation} copyButtonAriaLabel="Copy recommendation" copySuccessText="Recommendation copied" copyErrorText="Unable to copy"/>}><div className="chat-ai-label">Deck agent · Generated by AI</div><div className="chat-message-text"><Markdown text={event.data.recommendation||'Your deck and budget are ready for review.'}/></div>{date&&<Box fontSize="body-s" color="text-body-secondary">{date}</Box>}</ChatBubble><ArtifactPreview artifact={{id:event.id,kind:'budget',result:event.data}} onOpen={openArtifact}/></div>;
            if(event.type==='question')return <div id={event.id} key={event.id} tabIndex={-1}><ChatBubble type="incoming" avatar={agentAvatar()} ariaLabel="Agent question"><div className="chat-message-text"><Markdown text={event.data.question}/></div></ChatBubble></div>;
            if(event.type==='stopped')return <div id={event.id} key={event.id} tabIndex={-1}><StatusIndicator type="stopped">{event.data.message}</StatusIndicator></div>;
            return <div id={event.id} key={event.id} tabIndex={-1}><Alert type="error" header="Request interrupted">{event.data.message}</Alert></div>;
          })}</SpaceBetween>
          {busy&&!question&&<div className="chat-working"><ChatBubble type="incoming" avatar={agentAvatar(true)} ariaLabel="Agent working" showLoadingBar>{currentLabel}</ChatBubble></div>}
        </div></div></div>
        <div className="chat-input">{composer}</div>
      </>}
      <LiveRegion hidden>{announcement}</LiveRegion>
      {localArtifact&&<Modal visible size="max" header={artifactTitle(localArtifact)} closeAriaLabel="Close result preview" onDismiss={()=>{setLocalArtifact(null);previewTrigger.current?.focus();}}><ArtifactContent artifact={localArtifact}/></Modal>}
      {renameTarget&&<Modal visible header="Rename conversation" closeAriaLabel="Close rename modal" onDismiss={()=>{setRenameTarget(null);setRenameError('');}} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={()=>{setRenameTarget(null);setRenameError('');}}>Cancel</Button><Button variant="primary" loading={renaming} disabled={!renameTitle.trim()} onClick={()=>void handleRename()}>Save</Button></SpaceBetween></Box>}><FormField label="Conversation title" errorText={renameError}><Input value={renameTitle} onChange={({detail})=>setRenameTitle(detail.value)} placeholder="Enter new title" name="conversation-title" autoComplete="off" nativeInputAttributes={settingsInputAttributes}/></FormField></Modal>}
      {deleteTarget&&<Modal visible header="Delete conversation" closeAriaLabel="Close delete modal" onDismiss={()=>{setDeleteTarget(null);setDeleteError('');}} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={()=>{setDeleteTarget(null);setDeleteError('');}}>Cancel</Button><Button variant="primary" loading={deleting} onClick={()=>void handleDelete()}>Delete</Button></SpaceBetween></Box>}>{deleteError&&<Alert type="error">{deleteError}</Alert>}<Box>Are you sure you want to delete &ldquo;{deleteTarget?.title}&rdquo;? This cannot be undone.</Box></Modal>}
    </div>
  </>;
}

