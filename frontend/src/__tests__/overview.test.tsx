import {render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Admin} from '../Admin';
import {Overview} from '../Overview';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const accounts=[{id:'1',username:'Admin',role:'admin',active:true},{id:'2',username:'User',role:'user',active:true},{id:'3',username:'Disabled',role:'user',active:false}];
const models=[{id:'a',label:'A',provider:'openai',api_id:'a',enabled:true,verified_at:'2026-11-08T00:00:00Z'},{id:'b',label:'B',provider:'mistral',api_id:'b',enabled:false}];
const policies=[{role:'user',daily_token_limit:50000,allowed_model_ids:['b'],reset_timezone:'Asia/Tokyo'},{role:'admin',daily_token_limit:200000,allowed_model_ids:null,reset_timezone:'Asia/Tokyo'}];
function fixtures(path:string){return path.endsWith('/accounts')?accounts:path.endsWith('/models')?models:policies;}
afterEach(()=>vi.unstubAllGlobals());

it('summarizes active resources and intersects role access with global model enablement',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(fixtures(path))));
  const navigate=vi.fn(),user=userEvent.setup();render(<Admin token="fixture" section="overview" onNavigate={navigate}/>);
  await screen.findByText('User chat access blocked');
  expect(screen.getByTestId('overview-active-accounts')).toHaveTextContent('2');
  expect(screen.getByTestId('overview-enabled-models')).toHaveTextContent('1');
  expect(screen.getByTestId('overview-usable-roles')).toHaveTextContent('1');
  expect(screen.getByText('3 total accounts')).toBeInTheDocument();
  const quotas=screen.getByTestId('overview-role-quotas');
  expect(within(quotas).getByText('50,000')).toBeInTheDocument();
  expect(within(quotas).getByText('0 enabled models')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'View accounts'}));
  await user.click(screen.getByRole('button',{name:'View model policies'}));
  await user.click(screen.getByRole('button',{name:'Manage role access'}));
  expect(navigate.mock.calls).toEqual([['accounts'],['models'],['roles']]);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  expect(vi.mocked(fetch).mock.calls.every(call=>!call[1]?.method||call[1].method==='GET')).toBe(true);
});

it('keeps independent data available on a failed request and recovers with refresh',async()=>{
  let fail=true;
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/models')&&fail?json({error:{message:'Model registry unavailable'}},503):json(fixtures(path))));
  const user=userEvent.setup();render(<Overview token="fixture"/>);
  await screen.findByText('Model policies unavailable');
  expect(screen.getByTestId('overview-active-accounts')).toHaveTextContent('2');
  expect(screen.getByTestId('overview-enabled-models')).toHaveTextContent('Unavailable');
  expect(screen.getByTestId('overview-usable-roles')).toHaveTextContent('Unavailable');
  expect(screen.getByText('50,000')).toBeInTheDocument();
  expect(screen.queryByText('No models enabled')).not.toBeInTheDocument();
  expect(screen.queryByText(/Last refreshed/)).not.toBeInTheDocument();
  fail=false;await user.click(screen.getByRole('button',{name:'Refresh'}));
  await screen.findByText('User chat access blocked');
  expect(screen.queryByText('Model policies unavailable')).not.toBeInTheDocument();
  expect(screen.getByTestId('overview-enabled-models')).toHaveTextContent('1');
  expect(screen.getByText(/Last refreshed/)).toBeInTheDocument();
});

it('shows loading instead of zero counts until requests finish',async()=>{
  const pending:Array<(response:Response)=>void>=[];
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{pending.push(resolve);})));
  const view=render(<Overview token="fixture"/>);
  for(const id of ['overview-active-accounts','overview-enabled-models','overview-usable-roles'])expect(screen.getByTestId(id)).toHaveTextContent('Loading');
  expect(screen.queryByText('No models enabled')).not.toBeInTheDocument();
  view.unmount();pending.forEach(finish=>finish(json([])));
});

it('highlights empty configuration and zero quotas without inventing availability',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/role-policies')?policies.map(policy=>({...policy,daily_token_limit:0})):[])));
  render(<Overview token="fixture"/>);
  await screen.findByText('No active administrator');
  expect(screen.getByText('No models enabled')).toBeInTheDocument();
  expect(screen.getByText('User, Administrator chat access blocked')).toBeInTheDocument();
  expect(screen.getAllByText('Blocked by quota')).toHaveLength(2);
  expect(screen.getByTestId('overview-usable-roles')).toHaveTextContent('0');
});

it('does not report access configured when role policies are missing',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/role-policies')?[]:fixtures(path))));
  render(<Overview token="fixture"/>);
  expect(await screen.findByText('User, Administrator policies missing')).toBeInTheDocument();
  expect(screen.queryByText('Both roles have chat access')).not.toBeInTheDocument();
});

it('prevents an older token response from overwriting the current dashboard',async()=>{
  const pending=new Map<string,(response:Response)=>void>();
  vi.stubGlobal('fetch',vi.fn((path:string,options:RequestInit)=>String((options.headers as Record<string,string>).Authorization).includes('old')?new Promise<Response>(resolve=>pending.set(path,resolve)):Promise.resolve(json(fixtures(path)))));
  const view=render(<Overview token="old"/>);view.rerender(<Overview token="new"/>);
  await screen.findByText('User chat access blocked');
  for(const resolve of pending.values())resolve(json([]));
  await waitFor(()=>expect(screen.getByTestId('overview-active-accounts')).toHaveTextContent('2'));
  expect(screen.queryByText('No active administrator')).not.toBeInTheDocument();
});
