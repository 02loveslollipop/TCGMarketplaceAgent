import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Admin} from '../Admin';

afterEach(()=>vi.unstubAllGlobals());
const model={id:'gpt-6-luna',label:'GPT 6 luna',provider:'openai',api_id:'gpt-6-luna',enabled:false,verified_at:null};

it('renders an independent model policy portal and submits explicit enabled state',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>new Response(JSON.stringify(path.includes('/accounts')?[]:options?.method==='PUT'?model:[model]),{headers:{'Content-Type':'application/json'}})));
  const user=userEvent.setup();render(<Admin token="admin-token"/>);
  await screen.findByText('Disabled');
  expect(screen.getByTestId('admin-models-table')).toHaveTextContent('gpt-6-luna');
  await user.click(screen.getByRole('checkbox',{name:'Enabled for agent use'}));
  await user.click(screen.getByRole('button',{name:'Save model policy'}));
  await screen.findByText('Model policy saved.');
  const call=vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='PUT')!;
  expect(JSON.parse(String(call[1]!.body))).toEqual({label:'GPT 6 luna',provider:'openai',api_id:'gpt-6-luna',enabled:true});
});

it('reports server rejection of unverified or unavailable API IDs',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>options?.method==='PUT'?new Response(JSON.stringify({error:{message:'API ID unavailable'}}),{status:422}):new Response(JSON.stringify(path.includes('/accounts')?[]:[model]))));
  const user=userEvent.setup();render(<Admin token="admin-token"/>);
  await screen.findByText('Disabled');await user.click(screen.getByRole('button',{name:'Save model policy'}));
  expect(await screen.findByText('API ID unavailable')).toBeInTheDocument();
});

it('requires a sufficiently long account password before account creation',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('[]')));
  render(<Admin token="admin-token"/>);
  expect(screen.getByRole('button',{name:'Create account'})).toBeDisabled();
});
