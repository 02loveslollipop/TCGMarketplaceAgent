import {fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {RolePolicies} from '../RolePolicies';
import {Admin} from '../Admin';
import {TotpSettings} from '../TotpSettings';
import {WebAuthnSettings} from '../WebAuthn';
vi.mock('@simplewebauthn/browser',()=>({startAuthentication:vi.fn(),startRegistration:vi.fn(),WebAuthnAbortService:{cancelCeremony:vi.fn()}}));
afterEach(()=>vi.unstubAllGlobals());
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const policies=[{role:'user',daily_token_limit:50000,allowed_model_ids:null,reset_timezone:'Asia/Tokyo'},{role:'admin',daily_token_limit:200000,allowed_model_ids:null,reset_timezone:'Asia/Tokyo'}];
const model={id:'fixture',label:'Fixture model',provider:'openai',api_id:'fixture',enabled:true};

it('validates and saves a role-specific quota and explicit model access',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>json(options?.method==='PUT'?{...policies[0],...JSON.parse(String(options.body))}:path.endsWith('/models')?[model]:policies)));
 const user=userEvent.setup();render(<RolePolicies token="admin"/>);
 await user.click(await screen.findByRole('button',{name:'Edit User policy'}));
 const input=screen.getByLabelText('Daily token quota per user');
 await user.clear(input);await user.type(input,'-1');await user.click(screen.getByRole('button',{name:'Save role policy'}));
 expect(screen.getByText('Enter a whole number between 0 and 1,000,000,000.')).toBeInTheDocument();
 expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='PUT')).toBe(false);
 await user.clear(input);await user.type(input,'25000');
 await user.click(screen.getByRole('checkbox',{name:'Use all globally enabled models'}));
 await user.click(within(screen.getByTestId('role-model-select')).getByRole('button'));
 await user.click(screen.getByRole('option',{name:/Fixture model/}));
 await user.click(screen.getByRole('button',{name:'Save role policy'}));
 expect(await screen.findByText('User access policy saved.')).toBeInTheDocument();
 const call=vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='PUT')!;
 expect(String(call[0])).toContain('/role-policies/user');
 expect(JSON.parse(String(call[1]?.body))).toEqual({daily_token_limit:25000,allowed_model_ids:['fixture']});
});

it('protects a policy draft on cancel and keeps recoverable save errors in the form',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>options?.method==='PUT'?json({error:{message:'Fixture save rejected'}},422):json(path.endsWith('/models')?[model]:policies)));
 const user=userEvent.setup();render(<RolePolicies token="admin"/>);
 await user.click(await screen.findByRole('button',{name:'Edit User policy'}));
 await user.type(screen.getByLabelText('Daily token quota per user'),'1');
 await user.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.getByText('Discard policy changes?')).toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Keep editing'}));await user.click(screen.getByRole('button',{name:'Save role policy'}));
 expect(await screen.findByText('Fixture save rejected')).toBeInTheDocument();
 expect(screen.getByLabelText('Daily token quota per user')).toHaveValue('500001');
});

it('submits account role changes with the target identity and confirms the result',async()=>{
 const account={id:'fixture-user',username:'Fixture user',role:'user',active:true};
 vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>json(options?.method==='PUT'?{...account,role:'admin',sign_in_again:false}:path.endsWith('/accounts')?[account]:[model])));
 const user=userEvent.setup();render(<Admin token="admin" section="accounts"/>);
 await user.click(await screen.findByRole('button',{name:'Change role for Fixture user'}));
 const dialog=screen.getByRole('dialog',{name:'Change role for Fixture user'});
 await user.click(within(dialog).getByRole('button',{name:/Account role/}));
 await user.click(screen.getByRole('option',{name:'Administrator'}));await user.click(within(dialog).getByRole('button',{name:'Save role'}));
 expect(await screen.findByText('Fixture user role changed to Administrator. Existing sessions revoked.')).toBeInTheDocument();
 const call=vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='PUT')!;
 expect(String(call[0])).toContain('/accounts/fixture-user/role');expect(JSON.parse(String(call[1]?.body))).toEqual({role:'admin'});
});

it('creates an authenticator app in place and protects cancellation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>json({secret:'fixture-key',uri:'otpauth://totp/Fixture?secret=JBSWY3DPEHPK3PXP'})));
 const user=userEvent.setup(),done=vi.fn();render(<TotpSettings embedded token="fixture" enrolled={false} onEnrollment={done}/>);
 await user.click(screen.getByRole('button',{name:'Set up authenticator'}));
 expect(await screen.findByRole('img',{name:'Authenticator setup QR code'})).toBeInTheDocument();
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Cancel setup'}));
 await user.click(screen.getByRole('button',{name:'Discard setup'}));
 expect(screen.queryByRole('img',{name:'Authenticator setup QR code'})).not.toBeInTheDocument();expect(done).not.toHaveBeenCalled();
});

it('opens passkey setup in a modal and protects dismissal before restoring focus',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>json([])));
 const user=userEvent.setup();render(<WebAuthnSettings embedded token="fixture" onChange={vi.fn()}/>);
 const add=screen.getByRole('button',{name:'Add authenticator'});
 expect(screen.queryByLabelText('Authenticator name')).not.toBeInTheDocument();
 await user.click(add);
 const dialog=screen.getByRole('dialog',{name:'Add passkey or security key'});
 expect(dialog).toContainElement(document.activeElement as HTMLElement);
 await user.type(within(dialog).getByLabelText('Authenticator name'),'Fixture key');
 expect(screen.getByTestId('webauthn-credentials-table')).toBeInTheDocument();
 expect(within(dialog).getByLabelText('Authenticator name')).toHaveValue('Fixture key');
 fireEvent.keyDown(within(dialog).getByLabelText('Authenticator name'),{key:'Escape',code:'Escape',keyCode:27});
 expect(screen.getByRole('dialog',{name:'Discard authenticator setup?'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Keep setting up'})).toHaveFocus();
 await user.click(screen.getByRole('button',{name:'Keep setting up'}));
 expect(screen.getByLabelText('Authenticator name')).toHaveValue('Fixture key');
 expect(screen.getByLabelText('Authenticator name')).toHaveFocus();
 await user.click(screen.getByRole('button',{name:'Cancel setup'}));await user.click(screen.getByRole('button',{name:'Discard setup'}));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
 expect(screen.queryByLabelText('Authenticator name')).not.toBeInTheDocument();await waitFor(()=>expect(add).toHaveFocus());
});
