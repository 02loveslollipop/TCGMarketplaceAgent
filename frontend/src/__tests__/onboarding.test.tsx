import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Login} from '../Login';
import {Onboarding} from '../Onboarding';
import {RecoveryLogin,RecoverySettings} from '../Recovery';
import {TotpSettings} from '../TotpSettings';
import {startRegistration} from '@simplewebauthn/browser';

vi.mock('@simplewebauthn/browser',()=>({startAuthentication:vi.fn(),startRegistration:vi.fn(),WebAuthnAbortService:{cancelCeremony:vi.fn()}}));
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();window.history.replaceState(null,'',window.location.pathname);});

it('keeps login restricted through TOTP confirmation and clears codes when finished',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/token')?json({enrollment_token:'limited'}):path.endsWith('/enrollment')?json({secret:'fixture-secret',uri:'otpauth://totp/Pokemon:user?secret=FIXTURESECRET&issuer=Pokemon'}):json({recovery_codes:['fixture-code']})));
  const user=userEvent.setup(),onLogin=vi.fn();render(<Login onLogin={onLogin}/>);
  await user.type(screen.getByLabelText('Username'),'new-user');await user.type(screen.getByLabelText('Password'),'password');await user.click(screen.getByRole('button',{name:'Sign in'}));
  await user.click(await screen.findByRole('button',{name:'Set up authenticator app'}));
  expect(screen.getByRole('img',{name:'Authenticator setup QR code'})).toBeInTheDocument();
  expect(screen.queryByLabelText('Setup key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name: /Can't scan the QR code/}));
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
  expect(screen.getByRole('heading',{name:'Recovery codes'})).toBeInTheDocument();
  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Generate new recovery codes'}));
  expect(screen.getByLabelText('Current password')).toBeVisible();
  expect(screen.getByTestId('recovery-regenerate-button')).toBeDisabled();
  await user.type(screen.getByLabelText('Current password'),'password');
  await user.click(screen.getByTestId('recovery-regenerate-button'));
  expect(await screen.findByText('new-code')).toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Download recovery codes'}));expect(create).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledWith('blob:test');
  const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/regenerate'))!;expect(JSON.parse(String(call[1]?.body))).toEqual({password:'password'});
});

it('submits a recovery code with the password challenge and handles rejection',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(json({error:{message:'Invalid code'}},401)).mockResolvedValueOnce(json({enrollment_token:'reset-only',recovery_reset:true})));
  const user=userEvent.setup(),authenticated=vi.fn().mockResolvedValue(undefined);render(<RecoveryLogin challengeToken="proof" onAuthenticated={authenticated}/>);
  await user.click(screen.getByRole('button',{name:'Use a recovery code'}));await user.type(screen.getByLabelText('Recovery code'),'bad');await user.click(screen.getByRole('button',{name:'Use recovery code'}));
  expect(await screen.findByText('Invalid code')).toBeInTheDocument();expect(authenticated).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Recovery code'),'good');await user.click(screen.getByRole('button',{name:'Use recovery code'}));await waitFor(()=>expect(authenticated).toHaveBeenCalledWith({enrollment_token:'reset-only',recovery_reset:true}));
});


it('shows a QR code and manual fallback when adding an authenticator in settings',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json({secret:'settings-key',uri:'otpauth://totp/Pokemon:user?secret=SETTINGSKEY&issuer=Pokemon'})));
  const user=userEvent.setup();render(<TotpSettings token="full" enrolled={false} onEnrollment={()=>{}}/>);
  await user.click(screen.getByRole('button',{name:'Authenticator settings'}));
  await user.click(screen.getByRole('button',{name:'Set up authenticator'}));
  expect(await screen.findByRole('img',{name:'Authenticator setup QR code'})).toBeInTheDocument();
  expect(screen.queryByLabelText('Setup key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name: /Can't scan the QR code/}));
  expect(screen.getByLabelText('Setup key')).toHaveValue('settings-key');
});

it('switches verification methods and restricts recovery to new-factor enrollment',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/token')?json({challenge_token:'password-proof',methods:['webauthn','totp','recovery']}):path.endsWith('/recovery/challenge')?json({requires_enrollment:true,recovery_reset:true,enrollment_token:'restricted-reset'}):json({})));
  const user=userEvent.setup(),onLogin=vi.fn();render(<Login onLogin={onLogin}/>);
  await user.type(screen.getByLabelText('Username'),'fixture');await user.type(screen.getByLabelText('Password'),'fixture-password');await user.click(screen.getByRole('button',{name:'Sign in'}));
  await user.type(await screen.findByLabelText('Authenticator code'),'123456');
  await user.click(screen.getByRole('radio',{name:'Passkey or security key'}));
  expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Use passkey or security key'})).toBeInTheDocument();
  await user.click(screen.getByRole('radio',{name:'Authenticator app'}));
  expect(screen.getByLabelText('Authenticator code')).toHaveValue('');
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  expect(screen.queryByRole('radio',{name:/Recover/})).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Recovery code')).not.toBeInTheDocument();
  const link=screen.getByRole('link',{name:"Can't use your authenticator?"});
  expect(within(screen.getByTestId('login-form')).queryByRole('link',{name:"Can't use your authenticator?"})).not.toBeInTheDocument();
  expect(screen.getByTestId('login-form').compareDocumentPosition(link)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(link);
  expect(window.location.hash).toBe('#account-recovery');
  expect(screen.getByRole('heading',{name:'Recover account'})).toContainElement(document.activeElement as HTMLElement);
  expect(screen.queryByRole('heading',{name:'Verify your sign-in'})).not.toBeInTheDocument();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Recovery code'),'fixture-code{Enter}');
  expect(await screen.findByRole('heading',{name:'Secure your recovered account'})).toBeInTheDocument();
  expect(onLogin).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).endsWith('/session'))).toBe(false);
});


it('returns to verification from the recovery page and clears abandoned recovery codes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json({challenge_token:'proof',methods:['totp','recovery']})));
  const user=userEvent.setup(),onLogin=vi.fn();const {unmount}=render(<Login onLogin={onLogin}/>);
  await user.type(screen.getByLabelText('Username'),'fixture');await user.type(screen.getByLabelText('Password'),'fixture-password');await user.click(screen.getByRole('button',{name:'Sign in'}));
  await user.click(await screen.findByRole('link',{name:"Can't use your authenticator?"}));
  await user.type(screen.getByLabelText('Recovery code'),'private-fixture');
  await user.click(screen.getByRole('link',{name:'Back to verification'}));
  expect(window.location.hash).toBe('');
  expect(screen.getByRole('heading',{name:'Verify your sign-in'})).toBeInTheDocument();
  expect(screen.queryByLabelText('Recovery code')).not.toBeInTheDocument();
  await user.click(screen.getByRole('link',{name:"Can't use your authenticator?"}));
  expect(screen.getByLabelText('Recovery code')).toHaveValue('');
  expect(onLogin).not.toHaveBeenCalled();
  unmount();window.history.replaceState(null,'',window.location.pathname);
  vi.stubGlobal('fetch',vi.fn(async()=>json({challenge_token:'proof',methods:['totp']})));
  render(<Login onLogin={vi.fn()}/>);
  await user.type(screen.getByLabelText('Username'),'fixture');await user.type(screen.getByLabelText('Password'),'fixture-password');await user.click(screen.getByRole('button',{name:'Sign in'}));
  await screen.findByLabelText('Authenticator code');
  expect(screen.queryByRole('link',{name:"Can't use your authenticator?"})).not.toBeInTheDocument();
});

it('requires password verification when the recovery page is opened directly',async()=>{
  window.history.replaceState(null,'','#account-recovery');
  const onLogin=vi.fn();render(<Login onLogin={onLogin}/>);
  expect(screen.getByRole('heading',{name:'Sign in to recover'})).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toBeInTheDocument();
  expect(screen.queryByLabelText('Recovery code')).not.toBeInTheDocument();
  expect(onLogin).not.toHaveBeenCalled();
});

it('places back navigation in the footer for either verification method and clears the password challenge',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json({challenge_token:'proof',methods:['totp','webauthn','recovery']})));
  const user=userEvent.setup(),onLogin=vi.fn();render(<Login onLogin={onLogin}/>);
  expect(screen.queryByText('Sign in with your private PoC account.')).not.toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Back to sign in'})).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Username'),'fixture');await user.type(screen.getByLabelText('Password'),'fixture-password');await user.click(screen.getByRole('button',{name:'Sign in'}));
  await user.type(await screen.findByLabelText('Authenticator code'),'123456');
  const back=screen.getByRole('link',{name:'Back to sign in'});
  expect(screen.getByTestId('login-form').compareDocumentPosition(back)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('Start sign-in again')).not.toBeInTheDocument();
  await user.click(screen.getByRole('radio',{name:'Passkey or security key'}));
  expect(screen.queryByText('Start sign-in again')).not.toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Back to sign in'})).toBeInTheDocument();
  await user.click(screen.getByRole('link',{name:'Back to sign in'}));
  expect(screen.getByLabelText('Username')).toHaveValue('fixture');
  expect(screen.getByLabelText('Password')).toHaveValue('');
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.queryByRole('link',{name:"Can't use your authenticator?"})).not.toBeInTheDocument();
  expect(onLogin).not.toHaveBeenCalled();
});
