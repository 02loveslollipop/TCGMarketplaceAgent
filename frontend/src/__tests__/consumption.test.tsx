import {render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Consumption} from '../Consumption';
import {AdminActivity,executionEntries,publicAuditValue} from '../AdminActivity';
import type {ConsumptionReport,AdminExecutionDetail,Session} from '../contracts';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const base={input_tokens:4000,output_tokens:1000,total_tokens:5000,estimated_cost_usd:'.001',priced_tokens:3000,unpriced_tokens:2000,verified_calls:3,rejected_calls:0,unverified_calls:0};
export const usageFixture:ConsumptionReport={start_date:'2026-11-07',end_date:'2026-11-13',today:'2026-11-13',timezone:'Asia/Tokyo',summary:{...base,id:'total',name:'Usage'},daily:[{...base,id:'2026-11-13',name:'2026-11-13'}],principals:[{...base,id:'alice',name:'Alice',principal_type:'user',today_tokens:4000,daily_token_limit:10000,quota_known:true,current_role_name:'Reviewer'}],roles:[{...base,id:'author',name:'Author at call time'}],models:[{...base,id:'luna',name:'Luna'}],active_calls:0,detail_truncated:false,notice:'Indicative cost; unknown prices stay unknown.',generated_at:'2026-11-13T05:00:00Z'};
const price={model_id:'luna',label:'Luna',provider:'openai',api_id:'gpt-6-luna',pricing:{input_per_million:'.1',output_per_million:'.5',currency:'USD',source_url:'https://example.com/pricing'}};
function fixtures(path:string){return path.includes('/model-pricing')?[price]:usageFixture;}
afterEach(()=>vi.unstubAllGlobals());

it('shows period consumption separately from current quotas and labels incomplete cost coverage',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(fixtures(path))));render(<Consumption token="fixture"/>);
 expect(screen.getByTestId('usage-total')).toHaveTextContent('Loading');
 await waitFor(()=>expect(screen.getByTestId('usage-total')).toHaveTextContent('5,000'));
 expect(screen.getByTestId('usage-cost')).toHaveTextContent('$0.001');
 expect(screen.getByText('Cost coverage is incomplete')).toBeInTheDocument();
 expect(screen.getByText('Reviewer')).toBeInTheDocument();
 expect(screen.getByText('4,000 / 10,000')).toBeInTheDocument();
 expect(screen.getByText(/Quotas reset at midnight Japan time/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Alice'})).toBeInTheDocument();
});

it('requests historical-role filters on drill-down and clears them without mutating settings',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(fixtures(path))));const user=userEvent.setup();render(<Consumption token="fixture"/>);
 await screen.findByRole('button',{name:'Alice'});await user.click(screen.getByRole('tab',{name:'Historical roles'}));
 await user.click(within(screen.getByRole('table',{name:'Consumption by role'})).getByRole('button',{name:'Author at call time'}));
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).includes('role_id=author'))).toBe(true));
 await user.click(screen.getByRole('button',{name:'Clear usage filters'}));
 expect(vi.mocked(fetch).mock.calls.every(call=>!call[1]?.method||call[1]?.method==='GET')).toBe(true);
});

it('edits future pricing with validation and retains the reference in the request',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(fixtures(path))));const user=userEvent.setup();render(<Consumption token="fixture"/>);
 await user.click(await screen.findByRole('button',{name:'Edit pricing for Luna'}));
 const dialog=screen.getByRole('dialog',{name:'Edit pricing for Luna'});
 const input=within(dialog).getByLabelText('Input USD per million tokens');await user.clear(input);await user.type(input,'-1');
 await user.click(within(dialog).getByRole('button',{name:'Save pricing'}));
 expect(screen.getByText(/Provide both non-negative rates/)).toBeInTheDocument();
 expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='PUT')).toBe(false);
 await user.clear(input);await user.type(input,'0.2');await user.click(within(dialog).getByRole('button',{name:'Save pricing'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 const write=vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='PUT')!;expect(JSON.parse(String(write[1]!.body))).toMatchObject({currency:'USD',input_per_million:'0.2',output_per_million:'.5',source_url:'https://example.com/pricing'});
});

it('reports inaccessible data as unavailable rather than zero usage or zero cost',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>json({error:{message:'Consumption service unavailable'}},503)));render(<Consumption token="fixture" compact/>);
 expect(await screen.findByText('Consumption service unavailable')).toBeInTheDocument();
 expect(screen.getByTestId('usage-total')).toHaveTextContent('Unavailable');expect(screen.getByTestId('usage-cost')).toHaveTextContent('Unavailable');
});

it('keeps users without usage permissions out of the reporting API',async()=>{
 const session={id:'u',username:'u',role:'custom',policy_statements:[]} as unknown as Session;
 vi.stubGlobal('fetch',vi.fn());render(<Consumption token="fixture" session={session}/>);
 expect(await screen.findByText('Your role does not allow viewing consumption.')).toBeInTheDocument();expect(fetch).not.toHaveBeenCalled();
});

const detail:AdminExecutionDetail={id:'run',conversation_id:'chat',conversation_title:'Recorded deck',user_id:'other',model_id:'luna',status:'complete',created_at:'2026-11-13T00:00:01Z',checkpoint:{},reasoning_summary:'',events:[],logs:[],messages:[
 {id:'request',role:'user',created_at:'2026-11-13T00:00:00Z',content:{text:'Price this deck'}},
 {id:'summary',role:'assistant',created_at:'2026-11-13T00:00:02Z',content:{type:'thinking',execution_id:'run',data:{id:'s',status:'complete',source:'provider_summary',summary:'Verify card identities before comparing guides.'}}},
 {id:'tool',role:'assistant',created_at:'2026-11-13T00:00:03Z',content:{type:'tool',execution_id:'run',data:{id:'t',name:'get_cards',status:'complete',input:{card_ids:'one'},sources:[],duration_ms:20}}},
 {id:'other-run',role:'assistant',created_at:'2026-11-13T00:00:04Z',content:{type:'thinking',execution_id:'another',data:{summary:'Other execution should be excluded'}}}
]};
it('scopes the transcript to one execution and preserves reasoning and tool ordering',()=>{
 const entries=executionEntries(detail);expect(entries.map(entry=>entry.type)).toEqual(['user','thinking','tool']);expect(JSON.stringify(entries)).not.toContain('Other execution');
});
it('renders the AWS-style trace workspace and prevents resuming another principal’s execution',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.includes('/activity/run')?detail:path.includes('/activity')?[detail]:path.includes('/models')?[]:{status:'synced',sets_count:1,banned_count:0})));
 const user=userEvent.setup();render(<AdminActivity token="fixture" session={{id:'admin',username:'Admin',role:'admin'} as Session}/>);
 await user.click(await screen.findByRole('button',{name:'View trace for Recorded deck'}));
 expect(await screen.findByText('Verify card identities before comparing guides.')).toBeInTheDocument();
 expect(screen.getByText('Retrieve card batch')).toBeInTheDocument();
 expect(screen.getByText(/Read-only execution from another principal/)).toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'Test request'})).toHaveAttribute('readonly');
 expect(screen.getByRole('complementary',{name:'Execution context'})).toBeInTheDocument();
});

it('redacts credentials and private reasoning fields while retaining numeric usage in audit details',()=>{
 const result=JSON.stringify(publicAuditValue({input_tokens:123,password:'synthetic-private',reasoning_content:'private',note:'Bearer synthetic.token tcg_api_synthetic.secret',nested:{output_tokens:40}}));
 expect(result).toContain('123');expect(result).toContain('40');expect(result).not.toContain('synthetic');expect(result).not.toContain('private');expect(result).toContain('[Redacted]');
});

it('plots priced cost separately and explains omitted unknown costs',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(fixtures(path))));const user=userEvent.setup();render(<Consumption token="fixture"/>);
 await waitFor(()=>expect(screen.getByTestId('usage-total')).toHaveTextContent('5,000'));
 await user.click(screen.getByRole('button',{name:/Usage chart metric/}));
 await user.click(screen.getByRole('option',{name:'Priced cost (USD)'}));
 expect(await screen.findByText(/Missing costs are omitted rather than shown as zero or interpolated/)).toBeInTheDocument();
 expect(screen.getByTestId('usage-cost')).toHaveTextContent('$0.001');
});

it('uses the dedicated deck approval decision without starting a duplicate execution',async()=>{
 const pending={...detail,user_id:'admin',status:'waiting',checkpoint:{kind:'deck_approval',question:'Approve this resolved deck?',actions:['approve_deck','revise_deck','cancel']}};
 let resumed=false;
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{
  if(path.endsWith('/resume')){resumed=true;return new Response('event: execution\ndata: {"id":"run","conversation_id":"chat"}\n\nevent: done\ndata: {"status":"complete"}\n\n',{headers:{'Content-Type':'text/event-stream'}});}
  return json(path.includes('/activity/run')?{...pending,status:resumed?'complete':'waiting'}:path.includes('/activity')?[pending]:path.includes('/models')?[{id:'luna',label:'Luna'}]:{status:'synced',sets_count:1,banned_count:0});
 }));
 const user=userEvent.setup();render(<AdminActivity token="fixture" session={{id:'admin',username:'Admin',role:'admin'} as Session}/>);
 await user.click(await screen.findByRole('button',{name:'View trace for Recorded deck'}));
 await user.click(await screen.findByRole('button',{name:'Request changes'}));
 expect(screen.getByText('Enter a response before continuing.')).toBeInTheDocument();
 expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
 await user.click(screen.getByRole('button',{name:'Approve and price this deck'}));
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).endsWith('/resume'))).toBe(true));
 const writes=vi.mocked(fetch).mock.calls.filter(call=>call[1]?.method==='POST');expect(writes).toHaveLength(1);
 expect(JSON.parse(String(writes[0][1]!.body))).toMatchObject({action:'approve_deck',approved:true});
 expect(String(writes[0][0])).toBe('/api/chat/executions/run/resume');
});
