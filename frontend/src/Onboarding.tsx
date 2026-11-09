import {settingsInputAttributes} from './inputSemantics';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,FormField,Header,Input,SpaceBetween} from '@cloudscape-design/components';
import {startRegistration,WebAuthnAbortService,type PublicKeyCredentialCreationOptionsJSON} from '@simplewebauthn/browser';
import {api} from './client';
import {RecoveryCodes} from './Recovery';
import {TotpSetup} from './TotpSetup';

export function Onboarding({token,onFinish,recovery=false}:{token:string;onFinish:()=>void;recovery?:boolean}) {
  const [mode,setMode]=useState(''),[enrollment,setEnrollment]=useState<{secret:string;uri:string}|null>(null),[code,setCode]=useState(''),[name,setName]=useState(''),[codes,setCodes]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const ceremony=useRef(''),cancelled=useRef(false);
  async function cancel(){cancelled.current=true;WebAuthnAbortService.cancelCeremony();const id=ceremony.current;ceremony.current='';if(id)await api(`/api/auth/onboarding/webauthn/challenges/${id}/cancel`,token,{method:'POST'});}
  useEffect(()=>()=>{cancelled.current=true;WebAuthnAbortService.cancelCeremony();const id=ceremony.current;if(id)void api(`/api/auth/onboarding/webauthn/challenges/${id}/cancel`,token,{method:'POST'}).catch(()=>{});},[token]);
  function completed(result:{recovery_codes:string[]}){setEnrollment(null);setCode('');setCodes(result.recovery_codes);}
  async function beginTotp(){if(busy)return;setBusy(true);setError('');try{const result=await api<{secret:string;uri:string}>('/api/auth/onboarding/totp/enrollment',token,{method:'POST'});setEnrollment(result);setMode('totp');}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  async function confirm(){if(busy||!code)return;setBusy(true);setError('');try{completed(await api('/api/auth/onboarding/totp/confirmation',token,{method:'POST',body:JSON.stringify({code})}));}catch(error){setError((error as Error).message);}finally{setBusy(false);setCode('');}}
  async function register(){if(busy||!name.trim())return;setBusy(true);setError('');cancelled.current=false;try{
    const result=await api<{challenge_id:string;options:PublicKeyCredentialCreationOptionsJSON}>('/api/auth/onboarding/webauthn/registration/options',token,{method:'POST',body:JSON.stringify({name})});ceremony.current=result.challenge_id;
    if(cancelled.current){await cancel();throw new Error('Authenticator setup cancelled. Try again.');}
    const credential=await startRegistration({optionsJSON:result.options});
    if(cancelled.current)throw new Error('Authenticator setup cancelled. Try again.');
    completed(await api('/api/auth/onboarding/webauthn/registration/verify',token,{method:'POST',body:JSON.stringify({challenge_id:result.challenge_id,credential})}));ceremony.current='';
  }catch{try{await cancel();}catch{}setError('Authenticator setup was cancelled or could not be verified. Retry, or sign in again if setup expired.');}finally{setBusy(false);}}
  if(codes.length)return <RecoveryCodes codes={codes} onFinish={()=>{setCodes([]);onFinish();}}/>;
  return <SpaceBetween size="l"><Header variant="h2">{recovery?'Secure your recovered account':'Set up two-factor authentication'}</Header>{recovery&&<Alert type="warning">Your previous authenticators, sessions and recovery codes have been revoked. Set up a new authenticator and save the new recovery codes to restore access.</Alert>}<Alert type="info">Confirm an authenticator before accessing chat or administration. Setup expires after five minutes.</Alert>
    {!mode&&<><Button data-testid="onboarding-choose-totp" disabled={busy} onClick={()=>void beginTotp()}>Set up authenticator app</Button><Button data-testid="onboarding-choose-webauthn" disabled={busy} onClick={()=>setMode('webauthn')}>Set up passkey or security key</Button></>}
    {mode==='totp'&&<>{enrollment&&<TotpSetup {...enrollment}/>}<FormField label="Authenticator code"><Input data-testid="onboarding-totp-code" autoComplete="one-time-code" inputMode="numeric" nativeInputAttributes={settingsInputAttributes} value={code} disabled={busy} onChange={({detail})=>setCode(detail.value)}/></FormField><Button data-testid="onboarding-confirm-totp" disabled={busy||!code} loading={busy} onClick={()=>void confirm()}>Confirm authenticator app</Button></>}
    {mode==='webauthn'&&<><FormField label="Authenticator name"><Input data-testid="onboarding-authenticator-name" name="authenticator-display-name" nativeInputAttributes={settingsInputAttributes} autoComplete="off" value={name} disabled={busy} onChange={({detail})=>setName(detail.value)}/></FormField><Button data-testid="onboarding-register-key" disabled={busy||!name.trim()} loading={busy} onClick={()=>void register()}>Add passkey or security key</Button>{busy&&<Button data-testid="onboarding-cancel-key" onClick={()=>void cancel().catch(()=>setError('Cancellation could not be confirmed. Sign in again.'))}>Cancel authenticator</Button>}</>}
    {error&&<Alert type="error">{error}</Alert>}<Button data-testid="onboarding-restart" disabled={busy} onClick={()=>{setEnrollment(null);setCode('');onFinish();}}>Back to sign in</Button></SpaceBetween>;
}
