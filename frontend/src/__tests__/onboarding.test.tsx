import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Login} from '../Login';
import {Onboarding} from '../Onboarding';
import {RecoveryLogin,RecoverySettings} from '../Recovery';
import {startRegistration} from '@simplewebauthn/browser';

vi.mock('@simplewebauthn/browser',()=>({startAuthentication:vi.fn(),startRegistration:vi.fn(),WebAuthnAbortService:{cancelCeremony:vi.fn()}}));
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('keeps login restricted through TOTP confirmation and clears codes when finished',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/token')?json({enrollment_token:'limited'}):path.endsWith('/enrollment')?json({secret:'fixture-secret'}):json({recovery_codes:['fixture-code']})));
  const user=userEvent.setup(),onLogin=vi.fn();render(<Login onLogin={onLogin}/>);
  await user.type(screen.getByLabelText('Username'),'new-user');await user.type(screen.getByLabelText('Password'),'password');await user.click(screen.getByRole('button',{name:'Sign in'}));
  await user.click(await screen.findByRole('button',{name:'Set up authenticator app'}));
  expect(screen.getByLabelText('Setup key')).toHaveValue('fixture-secret');expect(onLogin).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Authenticator code'),'123456');await user.click(screen.getByRole('button',{name:'Confirm authenticator app'}));
  expect(await screen.findByText('fixture-code')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Finish setup and sign in'})).toBeDisabled();
  await user.click(screen.getByRole('checkbox',{name:'I have saved these recovery codes'}));await user.click(screen.getByRole('button',{name:'Finish setup and sign in'}));
  expect(screen.queryByText('fixture-code')).not.toBeInTheDocument();expect(screen.getByLabelText('Username')).toBeInTheDocument();expect(onLogin).not.toHaveBeenCalled();
});

it('verifies a named passkey before showing recovery codes',async()=>{
  vi.mocked(startRegistration).mockResolvedValue({id:'credential'} as never);
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/options')?json({challenge_id:'one',options:{challenge:'test'}}):json({recovery_codes:['code-one']})));
  const user=userEvent.setup(),finish=vi.fn();render(<Onboarding token="limited" onFinish={finish}/>);
  await user.click(screen.getByRole('button',{name:'Set up passkey or security key'}));await user.type(screen.getByLabelText('Authenticator name'),'Key');await user.click(screen.getByRole('button',{name:'Add passkey or security key'}));
  expect(await screen.findByText('code-one')).toBeInTheDocument();expect(finish).not.toHaveBeenCalled();
  const verify=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/verify'))!;
  expect(JSON.parse(String(verify[1]?.body))).toEqual({challenge_id:'one',credential:{id:'credential'}});
});

it('cancels an unsuccessful key ceremony and shows expired setup errors',async()=>{
  vi.mocked(startRegistration).mockRejectedValue(new DOMException('Cancelled','NotAllowedError'));
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/options')?json({challenge_id:'cancel-id',options:{challenge:'test'}}):json({cancelled:true})));
  const user=userEvent.setup();render(<Onboarding token="limited" onFinish={()=>{}}/>);
  await user.click(screen.getByRole('button',{name:'Set up passkey or security key'}));await user.type(screen.getByLabelText('Authenticator name'),'Key');await user.click(screen.getByRole('button',{name:'Add passkey or security key'}));
  expect(await screen.findByText(/setup was cancelled or could not be verified/)).toBeInTheDocument();expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).endsWith('/cancel-id/cancel'))).toBe(true);
});

it('surfaces an expired enrollment token without completing setup',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json({error:{message:'Enrollment expired. Sign in again.'}},401)));
  const user=userEvent.setup(),finish=vi.fn();render(<Onboarding token="expired" onFinish={finish}/>);
  await user.click(screen.getByRole('button',{name:'Set up authenticator app'}));
  expect(await screen.findByText('Enrollment expired. Sign in again.')).toBeInTheDocument();expect(finish).not.toHaveBeenCalled();
});

it('downloads codes and requires the current password for regeneration',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/status')?json({remaining:2}):json({recovery_codes:['new-code']})));
  const create=vi.fn(()=> 'blob:test'),revoke=vi.fn();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke}));vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  const user=userEvent.setup();render(<RecoverySettings token="full" onFinish={()=>{}}/>);
  await user.click(screen.getByRole('button',{name:'Recovery codes'}));expect(screen.getByRole('button',{name:'Generate new recovery codes'})).toBeDisabled();
  await user.type(screen.getByLabelText('Current password'),'password');await user.click(screen.getByRole('button',{name:'Generate new recovery codes'}));
  expect(await screen.findByText('new-code')).toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Download recovery codes'}));expect(create).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledWith('blob:test');
  const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/regenerate'))!;expect(JSON.parse(String(call[1]?.body))).toEqual({password:'password'});
});

it('submits a recovery code with the password challenge and handles rejection',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(json({error:{message:'Invalid code'}},401)).mockResolvedValueOnce(json({access_token:'verified'})));
  const user=userEvent.setup(),authenticated=vi.fn().mockResolvedValue(undefined);render(<RecoveryLogin challengeToken="proof" onAuthenticated={authenticated}/>);
  await user.click(screen.getByRole('button',{name:'Use a recovery code'}));await user.type(screen.getByLabelText('Recovery code'),'bad');await user.click(screen.getByRole('button',{name:'Use recovery code'}));
  expect(await screen.findByText('Invalid code')).toBeInTheDocument();expect(authenticated).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Recovery code'),'good');await user.click(screen.getByRole('button',{name:'Use recovery code'}));await waitFor(()=>expect(authenticated).toHaveBeenCalledWith({access_token:'verified'}));
});
