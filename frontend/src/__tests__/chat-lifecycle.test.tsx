import {StrictMode} from 'react';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Chat} from '../Chat';

const usage={daily_token_limit:5000,total_tokens:100,remaining_tokens:4900,unverified_usage:false,in_progress:false};
const models=[{id:'test-model',label:'Test model',provider:'openai',api_id:'test',enabled:true}];
const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('chat request lifecycle',()=>{
  it.each(['resolve','reject'] as const)('ignores a late %s from requests aborted by StrictMode cleanup',async(outcome)=>{
    const pending: {resolve:(value:Response)=>void;reject:(reason:unknown)=>void;signal:AbortSignal}[]=[];
    const counts=new Map<string,number>();
    vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
      const url=String(input);
      const count=(counts.get(url)||0)+1;counts.set(url,count);
      if(count===1&&(url.endsWith('/usage')||url.endsWith('/conversations'))){
        return new Promise<Response>((resolve,reject)=>pending.push({resolve,reject,signal:init!.signal!}));
      }
      if(url.endsWith('/usage'))return Promise.resolve(json(usage));
      if(url.endsWith('/conversations'))return Promise.resolve(json([{id:'current',title:'Current history'}]));
      if(url.endsWith('/models'))return Promise.resolve(json(models));
      throw new Error(`Unexpected request: ${url}`);
    });
    const onUsageChange=vi.fn();
    render(<StrictMode><Chat token="synthetic-lifecycle-token" authMode="api-token" onUsageChange={onUsageChange}/></StrictMode>);
    await screen.findByRole('button',{name:'Current history'});
    await waitFor(()=>expect(onUsageChange).toHaveBeenLastCalledWith(usage,''));
    expect(pending).toHaveLength(2);
    expect(pending.every(request=>request.signal.aborted)).toBe(true);
    await act(async()=>{
      pending.forEach((request,index)=>outcome==='reject'
        ?request.reject(new DOMException('Aborted','AbortError'))
        :request.resolve(json(index===0?{...usage,total_tokens:4999,remaining_tokens:1}:[{id:'old',title:'Stale history'}])));
    });
    expect(onUsageChange).toHaveBeenLastCalledWith(usage,'');
    expect(screen.getByRole('button',{name:'Current history'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Stale history'})).not.toBeInTheDocument();
    expect(screen.queryByText('History unavailable')).not.toBeInTheDocument();
  });

  it.each([['cancelled','cancelled'],['failed','error']] as const)('reports server %s without labelling the execution complete',async(status,expected)=>{
    vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
      const url=String(input);
      if(url.endsWith('/usage'))return json(usage);
      if(url.endsWith('/conversations'))return json([]);
      if(url.endsWith('/models'))return json(models);
      if(url.endsWith('/executions'))return new Response(`event: execution\ndata: {"id":"execution-terminal","conversation_id":"conversation-terminal"}\n\nevent: done\ndata: {"status":"${status}"}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
      throw new Error(`Unexpected request: ${url}`);
    });
    const onExecutionStateChange=vi.fn();
    const user=userEvent.setup();
    render(<Chat token="synthetic-lifecycle-token" authMode="api-token" onExecutionStateChange={onExecutionStateChange}/>);
    await screen.findByText('Active model: Test model');
    await user.type(screen.getByTestId('chat-prompt-textarea'),'Check the terminal status');
    await user.click(screen.getByRole('button',{name:'Send request'}));
    await waitFor(()=>expect(onExecutionStateChange).toHaveBeenLastCalledWith(expect.objectContaining({executionId:'execution-terminal',status:expected,lastEventType:'done'})));
  });
});
