import {Box,ExpandableSection,KeyValuePairs,Link,SpaceBetween,StatusIndicator,Steps} from '@cloudscape-design/components';
import type {ChatEntry} from './ChatActivity';
import type {AgentEvent} from './contracts';
import {Markdown} from './Markdown';
import {safeHref} from './client';

function toolTitle(data:{name:string;input?:Record<string,unknown>}) {
  switch(data.name){
    case 'search_cards':return 'Search card database';
    case 'get_card':return 'Retrieve card details';
    case 'get_cards':return 'Retrieve card batch';
    case 'query_tcgdex_graphql':return 'Query TCGdex';
    case 'search_deck_lists':return 'Search deck lists';
    case 'get_deck_list':return 'Retrieve deck list';
    case 'query_legality':return 'Query legality catalog';
    case 'baseline_prices':return `Baseline prices from ${data.input?.supplier||'supplier'}`;
    case 'check_supplier_stock':return `Check ${data.input?.supplier||'supplier'} stock`;
    case 'quote_supplier':return `Quote ${data.input?.supplier||'supplier'}`;
    case 'current_legality':return 'Check format evidence';
    case 'convert_currency':return 'Convert budget currency';
    default:return data.name.replaceAll('_',' ');
  }
}
export function ThinkingTrace({entries,active,defaultExpanded=false,heading}:{entries:ChatEntry[];active:boolean;defaultExpanded?:boolean;heading?:string}) {
  const items=entries.filter((entry):entry is ChatEntry&(Extract<AgentEvent,{type:'thinking'}>|Extract<AgentEvent,{type:'tool'}>)=>entry.type==='thinking'?Boolean(entry.data.summary?.trim()):entry.type==='tool'&&Boolean(entry.data.name));
  if(!items.length)return null;
  const summaries=items.filter(entry=>entry.type==='thinking');
  const relevant=summaries.length?summaries:items;
  const failed=relevant.some(entry=>entry.data.status==='error');
  const interrupted=!active&&relevant.some(entry=>entry.data.status==='loading'||entry.data.status==='error');
  const label=summaries.length?(active?'Thinking':interrupted?'Thinking interrupted':'Completed thinking'):(active?'Tool activity':interrupted?'Tool activity interrupted':'Completed tool activity');
  const toolErrors=items.filter(entry=>entry.type==='tool'&&entry.data.status==='error').length;
  return <div className="chat-thinking-trace" data-testid="thinking-trace">
    <ExpandableSection defaultExpanded={defaultExpanded} headerText={<StatusIndicator type={active?'loading':failed?'error':interrupted?'stopped':'info'}>{heading||label}</StatusIndicator>}
      headerDescription={`Reasoning summaries and tool calls${toolErrors?` · ${toolErrors} source ${toolErrors===1?'check':'checks'} could not complete`:''}`}>
      <Steps ariaLabel="Reasoning summaries and tool calls" steps={items.map(entry=>{
        const status=entry.data.status==='error'?'error' as const:entry.data.status==='loading'?(active?'loading' as const:'stopped' as const):entry.type==='thinking'||entry.data.diagnostic&&entry.data.diagnostic.outcome!=='success'?'info' as const:'success' as const;
        if(entry.type==='thinking')return {
          status,header:entry.data.source==='provider_summary'?'Model reasoning summary':'Approach summary',
          details:<SpaceBetween size="xs"><div className="chat-message-text"><Markdown text={entry.data.summary}/></div>
            {(entry.data.status==='error'||entry.data.status==='loading'&&!active)&&<StatusIndicator type={entry.data.status==='error'?'error':'stopped'}>Summary interrupted</StatusIndicator>}
          </SpaceBetween>,
        };
        const tool=entry.data;
        const inputs=Object.entries(tool.input||{}).filter(([,value])=>value!==undefined&&value!=='');
        return {
          status,header:<span data-testid="thinking-tool-call">{toolTitle(tool)}{tool.duration_ms!==undefined&&<Box variant="span" color="text-body-secondary" margin={{left:'xs'}}>{tool.duration_ms<1000?`${tool.duration_ms} ms`:`${Math.round(tool.duration_ms/1000)} s`}</Box>}</span>,
          details:<SpaceBetween size="s">
            {inputs.length>0&&<KeyValuePairs columns={1} items={inputs.map(([key,value])=>({label:key.replaceAll('_',' '),value:<Box variant="code">{typeof value==='string'?value:JSON.stringify(value)}</Box>}))}/>}
            {tool.diagnostic&&<KeyValuePairs columns={1} items={[
              {label:'Retrieval outcome',value:tool.diagnostic.outcome.replaceAll('_',' ')},
              {label:'Source layer',value:tool.diagnostic.layer},
              ...(tool.diagnostic.http_status?[{label:'HTTP status',value:String(tool.diagnostic.http_status)}]:[]),
              {label:'Details',value:tool.diagnostic.message},
            ]}/>}
            {tool.sources.length>0&&<SpaceBetween size="xs">{tool.sources.map((source,index)=><Link key={`${source.url}-${index}`} external href={safeHref(source.url)}>{source.title||`Source ${index+1}`}</Link>)}</SpaceBetween>}
          </SpaceBetween>,
        };
      })}/>
    </ExpandableSection>
  </div>;
}
