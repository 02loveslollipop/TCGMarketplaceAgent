import {Box,ExpandableSection,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import type {ChatEntry} from './ChatActivity';
import type {AgentEvent} from './contracts';
import {Markdown} from './Markdown';

export function ThinkingTrace({entries,active}:{entries:ChatEntry[];active:boolean}){
  const trace=entries.filter((entry):entry is ChatEntry&Extract<AgentEvent,{type:'thinking'}>=>entry.type==='thinking');
  if(!trace.length)return null;
  const failed=trace.some(entry=>entry.data.status==='error');
  const interrupted=!active&&trace.some(entry=>entry.data.status==='loading'||entry.data.status==='error');
  const label=active?'Thinking':interrupted?'Thinking interrupted':'Completed thinking';
  return <div className="chat-thinking-trace"><ExpandableSection headerText={<StatusIndicator type={active?'loading':failed?'error':interrupted?'stopped':'info'}>{label}</StatusIndicator>}>
    <SpaceBetween size="m">{trace.map(entry=><div key={entry.id}><Box fontWeight="bold">{entry.data.source==='provider_summary'?'Reasoning summary':'Approach summary'}</Box><div className="chat-message-text"><Markdown text={entry.data.summary}/></div>{(entry.data.status==='error'||entry.data.status==='loading'&&!active)&&<StatusIndicator type={entry.data.status==='error'?'error':'stopped'}>Summary interrupted</StatusIndicator>}</div>)}</SpaceBetween>
  </ExpandableSection></div>;
}
