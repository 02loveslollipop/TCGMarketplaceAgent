import {Box,ExpandableSection,Steps,StatusIndicator} from '@cloudscape-design/components';
import type {AgentEvent,Decision,Question} from './contracts';

export type ChatEvent=AgentEvent|{type:'user';data:{text:string;decision?:Decision}}|{type:'stopped';data:{message:string}};
export type ChatEntry=ChatEvent&{id:string;at?:string};
export function decisionText(decision:Decision,question?:Question|null){
  const scope=question?.missing?.map(card=>`${card.quantity} × ${card.name}${card.number?` #${card.number}`:''}${[card.set_name,card.language,card.condition,card.printing].filter(Boolean).length?` (${[card.set_name,card.language,card.condition,card.printing].filter(Boolean).join(' · ')})`:''}`).join(', ');
  switch(decision.action){
    case 'clarify':return decision.text||'Provided clarification';
    case 'substitute':return `Approved substitute research${scope?` for ${scope}`:''}: ${decision.text}`;
    case 'keep_missing':return `Approved keeping the listed cards missing${scope?`: ${scope}`:''}.`;
    case 'cancel':return 'Cancelled this execution.';
  }
}
export function ActivityTrace({entries,active,waiting=false}:{entries:ChatEntry[];active:boolean;waiting?:boolean}){
  const progress=entries.filter((entry):entry is ChatEntry&Extract<AgentEvent,{type:'progress'}>=>entry.type==='progress');
  if(!progress.length)return null;
  const failed=entries.some(entry=>entry.type==='error'||entry.type==='done'&&entry.data.status==='failed');
  const stopped=entries.some(entry=>entry.type==='stopped'||entry.type==='done'&&['cancelled','stopped'].includes(entry.data.status));
  const complete=entries.some(entry=>entry.type==='result'||entry.type==='cards'||entry.type==='done'&&entry.data.status==='complete');
  // Only count observed updates. These events do not supply a known total or a percentage.
  const status=active?'loading':failed?'error':stopped?'stopped':waiting?'pending':complete?'success':'info';
  return <div className="chat-activity-trace"><ExpandableSection defaultExpanded={active} headerText={<StatusIndicator type={status}>{active?'Agent activity':failed?'Activity ended with an error':stopped?'Activity stopped':waiting?'Activity paused for your decision':'Activity summary'}</StatusIndicator>}>
    <Steps ariaLabel="Agent activity" steps={progress.map((entry,index)=>({status:index===progress.length-1?status:'info',header:entry.data.message,details:entry.data.limitations?.map((item,i)=><Box key={i} color="text-status-warning">{item.supplier}: {item.message}</Box>)}))}/>
  </ExpandableSection></div>;
}
