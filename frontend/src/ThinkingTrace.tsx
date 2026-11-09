import {Box,ExpandableSection,Link,SpaceBetween,StatusIndicator,Steps} from '@cloudscape-design/components';
import type {ChatEntry} from './ChatActivity';
import type {AgentEvent} from './contracts';
import {safeHref} from './client';
import {Markdown} from './Markdown';

export function ThinkingTrace({entries,active}:{entries:ChatEntry[];active:boolean}){
  const trace=entries.filter((entry):entry is ChatEntry&Extract<AgentEvent,{type:'thinking'|'tool'}>=>entry.type==='thinking'||entry.type==='tool');
  if(!trace.length)return null;
  const native=trace.some(entry=>entry.type==='thinking'&&entry.data.source==='provider_summary');
  const hasSummary=trace.some(entry=>entry.type==='thinking');
  const failed=trace.some(entry=>entry.data.status==='error');
  const interrupted=!active&&trace.some(entry=>entry.type==='thinking'&&(entry.data.status==='loading'||entry.data.status==='error'));
  const label=native?(active?'Thinking':interrupted?'Thinking interrupted':'Completed thinking'):hasSummary?'Approach and tool calls':'Tool calls';
  return <div className="chat-thinking-trace"><ExpandableSection headerText={<StatusIndicator type={active?'loading':failed?'error':interrupted?'stopped':'info'}>{label}</StatusIndicator>}>
    <SpaceBetween size="m">{trace.map(entry=>entry.type==='thinking'?<div key={entry.id}><Box fontWeight="bold">{entry.data.source==='provider_summary'?'Reasoning summary':'Approach summary'}</Box><div className="chat-message-text"><Markdown text={entry.data.summary}/></div>{(entry.data.status==='error'||entry.data.status==='loading'&&!active)&&<StatusIndicator type={entry.data.status==='error'?'error':'stopped'}>Summary interrupted</StatusIndicator>}</div>:<Steps key={entry.id} ariaLabel={`Tool call ${entry.data.name}`} steps={[{status:entry.data.status==='loading'?(active?'loading':'stopped'):entry.data.status==='complete'?'success':'error',header:<><code>{entry.data.name}</code>{entry.data.duration_ms!==undefined&&` · ${(entry.data.duration_ms/1000).toFixed(1)} s`}</>,details:<SpaceBetween size="xs">{Object.entries(entry.data.input).map(([name,value])=><Box key={name}><strong>{name}:</strong> {value}</Box>)}{entry.data.sources.map(source=><Link key={source.url} href={safeHref(source.url)} external>{source.title}</Link>)}{entry.data.status==='error'&&<Box>Source unavailable; this tool call did not complete.</Box>}</SpaceBetween>}]}/> )}</SpaceBetween>
  </ExpandableSection></div>;
}
