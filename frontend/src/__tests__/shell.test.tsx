import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Shell} from '../Shell';
import {setAppearance} from '../appearance';

vi.mock('../Login',()=>({Login:({onLogin}:{onLogin:(token:string,user:unknown)=>void})=><button onClick={()=>onLogin('test-token',{id:'test',username:'fixture-user',role:'admin',totp_enrolled:true,webauthn_enrolled:true,webauthn_credentials_count:1})}>Fixture sign in</button>}));
vi.mock('../TotpSettings',()=>({TotpSettings:()=> <div>Authenticator settings fixture</div>}));
vi.mock('../WebAuthn',()=>({WebAuthnSettings:()=> <div>Passkeys fixture</div>}));
vi.mock('../Recovery',()=>({RecoverySettings:()=> <div>Recovery fixture</div>}));
afterEach(()=>{vi.unstubAllGlobals();window.location.hash='';setAppearance('light');});
const json=(value:unknown)=>new Response(JSON.stringify(value));

it('moves security to a dedicated page while preserving the chat draft and chosen model',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/models')?[{id:'test',label:'GPT test',provider:'openai',api_id:'test',enabled:true}]:[])));
  const user=userEvent.setup();render(<Shell/>);
  await user.click(await screen.findByRole('button',{name:'Fixture sign in'}));await screen.findByText('GPT test');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Keep this draft');
  expect(screen.queryByRole('heading',{name:'Account security'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'fixture-user'}));
  await user.click(screen.getByRole('menuitem',{name:'Account security'}));
  expect(screen.getByRole('heading',{name:'Account security'})).toBeInTheDocument();
  expect(screen.queryByRole('textbox',{name:'Purchase request'})).not.toBeInTheDocument();
  await user.click(within(screen.getByTestId('workspace-navigation')).getByRole('link',{name:'Deck agent'}));
  expect(screen.getByRole('textbox',{name:'Purchase request'})).toHaveValue('Keep this draft');
  expect(screen.getByTestId('active-model-summary')).toHaveTextContent('Active model: GPT test');
});

it('navigates from the administration overview to models and accounts',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json([])));
  const user=userEvent.setup();render(<Shell admin/>);
  await user.click(await screen.findByRole('button',{name:'Fixture sign in'}));
  expect(screen.getByRole('heading',{name:'Workspace overview'})).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'View model policies'}));
  expect(screen.getByRole('heading',{name:'Model policies',level:1})).toBeInTheDocument();
  await user.click(screen.getByRole('link',{name:'Accounts'}));
  expect(screen.getByRole('heading',{name:'Accounts',level:1})).toBeInTheDocument();
});

it('changes appearance from the top bar and keeps it after signing out',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json([])));
  const user=userEvent.setup();render(<Shell admin/>);
  await user.click(await screen.findByRole('button',{name:'Fixture sign in'}));
  for(const label of ['Dark','Dark blue','Light','Dark blue']){
    await user.click(screen.getByRole('button',{name:/Appearance:/}));
    await user.click(screen.getByRole('menuitem',{name:label}));
    const value=label.toLowerCase().replace(' ','-');
    expect(document.body.dataset.colorTheme).toBe(value);
    expect(localStorage.getItem('tcg-marketplace-appearance')).toBe(value);
  }
  await user.click(screen.getByRole('button',{name:'fixture-user'}));
  await user.click(screen.getByRole('menuitem',{name:'Sign out'}));
  expect(await screen.findByRole('button',{name:'Fixture sign in'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/Appearance:/})).not.toBeInTheDocument();
  expect(document.body.dataset.colorTheme).toBe('dark-blue');
});
