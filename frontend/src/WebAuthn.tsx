import {settingsInputAttributes} from './inputSemantics';
import {useEffect,useId,useRef,useState} from 'react';
import {Alert,Box,Button,Container,Header,ExpandableSection,FormField,Input,Modal,SpaceBetween,Table} from '@cloudscape-design/components';
import {startAuthentication,startRegistration,WebAuthnAbortService} from '@simplewebauthn/browser';
import type {PublicKeyCredentialCreationOptionsJSON,PublicKeyCredentialRequestOptionsJSON} from '@simplewebauthn/browser';
import {api} from './client';
import type {ButtonProps,InputProps} from '@cloudscape-design/components';

type AccessToken={access_token:string;token_type:string;expires_in:number};
interface Credential {id:string;name:string;created_at:string;device_type:string;backed_up:boolean}

function ceremonyError(error:unknown):string {
  const problem=error as {name?:string;code?:string;message?:string};
  if(problem.name==='NotAllowedError'||problem.name==='AbortError'||problem.code?.includes('ABORT'))return 'Authenticator operation was cancelled or timed out. You can try again.';
  if(problem.name==='InvalidStateError')return 'This authenticator may already be registered. Choose another authenticator and try again.';
  if(problem.name==='WebAuthnError'||problem.name==='NotSupportedError')return 'The authenticator could not complete verification. Check your browser or authenticator and try again.';
  return problem.message||'Authenticator operation failed. Please try again.';
}

export function WebAuthnLogin({challengeToken,disabled,onAuthenticated,onBusy}:{challengeToken:string;disabled:boolean;onAuthenticated:(result:AccessToken)=>Promise<void>;onBusy:(busy:boolean)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const ceremony=useRef<string|null>(null);
  const cancelled=useRef(false);
  useEffect(()=>()=>WebAuthnAbortService.cancelCeremony(),[]);
  async function cancelServer() {
    if(ceremony.current) {
      await api(`/api/auth/webauthn/challenges/${ceremony.current}/cancel`,'',{method:'POST',body:JSON.stringify({challenge_token:challengeToken})});
      ceremony.current=null;
    }
  }
  async function authenticate() {
    if(busy||disabled)return;
    cancelled.current=false;
    setBusy(true);onBusy(true);setError('');
    try {
      const request=await api<{challenge_id:string;options:PublicKeyCredentialRequestOptionsJSON}>('/api/auth/webauthn/authentication/options','',{method:'POST',body:JSON.stringify({challenge_token:challengeToken})});
      ceremony.current=request.challenge_id;
      if(cancelled.current)throw new DOMException('Cancelled','AbortError');
      const credential=await startAuthentication({optionsJSON:request.options});
      if(cancelled.current)throw new DOMException('Cancelled','AbortError');
      const result=await api<AccessToken>('/api/auth/webauthn/authentication/verify','',{method:'POST',body:JSON.stringify({challenge_token:challengeToken,challenge_id:request.challenge_id,credential})});
      ceremony.current=null;
      await onAuthenticated(result);
    }catch(error){setError(ceremonyError(error));try{await cancelServer();}catch{setError('The authenticator attempt could not be completed or cancelled. Sign in again to retry.');}}
    finally{setBusy(false);onBusy(false);}
  }
  function cancel(){cancelled.current=true;WebAuthnAbortService.cancelCeremony();}
  return <SpaceBetween size="m">
    <Box>Complete the second step with an enrolled passkey or security key. Your password has already been verified.</Box>
    {error&&<Alert type="error">{error}</Alert>}
    <Button data-testid="webauthn-login-button" formAction="none" variant="primary" disabled={busy||disabled} loading={busy} onClick={()=>void authenticate()}>Use passkey or security key</Button>
    {busy&&<Button data-testid="webauthn-login-cancel-button" formAction="none" onClick={cancel}>Cancel authenticator</Button>}
  </SpaceBetween>;
}

export function WebAuthnSettings({token,onChange,embedded=false}:{token:string;onChange:()=>void;embedded?:boolean}) {
  const [credentials,setCredentials]=useState<Credential[]>([]),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [creating,setCreating]=useState(false),[discard,setDiscard]=useState(false);
  const registrationForm=useId();
  const nameInput=useRef<InputProps.Ref>(null),keepSetup=useRef<ButtonProps.Ref>(null);
  useEffect(()=>{if(creating){if(discard)keepSetup.current?.focus();else nameInput.current?.focus();}},[creating,discard]);
  const createTrigger=useRef<HTMLElement|null>(null);
  function openCreate(){createTrigger.current=document.activeElement as HTMLElement;setName('');setDiscard(false);setCreating(true);setError('');}
  function closeCreate(){if(busy)return;if(name.trim())setDiscard(true);else discardCreate();}
  function discardCreate(){setName('');setCreating(false);setDiscard(false);setError('');}
  useEffect(()=>{if(!creating)createTrigger.current?.focus();},[creating]);
  const [removing,setRemoving]=useState<Credential|null>(null),[removalError,setRemovalError]=useState('');
  const removeTrigger=useRef<HTMLElement|null>(null);
  useEffect(()=>{if(!removing)removeTrigger.current?.focus();},[removing]);
  const ceremony=useRef<string|null>(null);
  const cancelled=useRef(false);
  useEffect(()=>{void api<Credential[]>('/api/auth/webauthn/credentials',token).then(setCredentials).catch(error=>setError(error.message));return()=>WebAuthnAbortService.cancelCeremony();},[token]);
  async function enroll() {
    if(busy||!name.trim())return;
    cancelled.current=false;
    setBusy(true);setError('');
    try {
      const request=await api<{challenge_id:string;options:PublicKeyCredentialCreationOptionsJSON}>('/api/auth/webauthn/registration/options',token,{method:'POST',body:JSON.stringify({name:name.trim()})});
      ceremony.current=request.challenge_id;
      if(cancelled.current)throw new DOMException('Cancelled','AbortError');
      const credential=await startRegistration({optionsJSON:request.options});
      if(cancelled.current)throw new DOMException('Cancelled','AbortError');
      await api('/api/auth/webauthn/registration/verify',token,{method:'POST',body:JSON.stringify({challenge_id:request.challenge_id,credential})});
      ceremony.current=null;setCreating(false);setName('');onChange();
    }catch(error){setError(ceremonyError(error));if(ceremony.current){try{await api(`/api/auth/webauthn/challenges/${ceremony.current}/cancel`,token,{method:'POST',body:'{}'});}catch{setError('Registration could not be completed or cancelled. Sign in again to retry.');}ceremony.current=null;}}
    finally{setBusy(false);}
  }
  async function remove(id:string) {
    if(busy)return;setBusy(true);setRemovalError('');
    try{await api(`/api/auth/webauthn/credentials/${id}`,token,{method:'DELETE'});setRemoving(null);onChange();}catch(error){setRemovalError((error as Error).message);}finally{setBusy(false);}
  }
  const content=<SpaceBetween size="m">
    <Box>Use your browser’s chooser to add a password-manager passkey or a physical security key. You will still enter your password before using it to sign in. Adding or removing an authenticator requires signing in again.</Box>
    {!creating&&error&&<Alert type="error">{error}</Alert>}
    <Table data-testid="webauthn-credentials-table" items={credentials} empty={<Box>No passkeys or security keys enrolled.</Box>} columnDefinitions={[
      {id:'name',header:'Authenticator',cell:credential=>credential.name},
      {id:'created',header:'Enrolled',cell:credential=>new Date(credential.created_at).toLocaleString()},
      {id:'remove',header:'Manage',cell:credential=><Button data-testid="webauthn-remove-button" variant="inline-link" disabled={busy} onClick={()=>{removeTrigger.current=document.activeElement as HTMLElement;setRemovalError('');setRemoving(credential);}}>Remove {credential.name}</Button>}
    ]}/>
    {!embedded&&<Button disabled={busy} onClick={openCreate}>Add authenticator</Button>}
    {creating&&<Modal visible header={discard?'Discard authenticator setup?':'Add passkey or security key'} closeAriaLabel="Close authenticator setup" onDismiss={closeCreate} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
      {discard?<><Button ref={keepSetup} onClick={()=>setDiscard(false)}>Keep setting up</Button><Button variant="primary" onClick={discardCreate}>Discard setup</Button></>:<>
        <Button variant="link" disabled={busy} onClick={closeCreate}>Cancel setup</Button>
        <Button data-testid="webauthn-enroll-button" variant="primary" disabled={busy||!name.trim()} loading={busy} onClick={()=>void enroll()}>Add passkey or security key</Button>
      </>}
    </SpaceBetween></Box>}>
      {discard?<Box>Your authenticator setup details will be discarded.</Box>:<SpaceBetween size="l">
        <Box>Name your authenticator, then use your browser’s chooser to create a passkey in your password manager or register a physical security key. After registration, sign in again to continue.</Box>
        <FormField label="Authenticator name" description="For example, Google Password Manager or Physical security key."><Input ref={nameInput} data-testid="webauthn-name-input" name="authenticator-display-name" nativeInputAttributes={settingsInputAttributes} autoComplete="off" value={name} disabled={busy} onChange={({detail})=>setName(detail.value)} onKeyDown={event=>{if(event.detail.key==='Enter'&&name.trim()&&!busy){event.preventDefault();void enroll();}}}/></FormField>
        {busy&&<Button data-testid="webauthn-enroll-cancel-button" formAction="none" onClick={()=>{cancelled.current=true;WebAuthnAbortService.cancelCeremony();}}>Cancel authenticator</Button>}
        {error&&<Alert type="error">{error}</Alert>}
      </SpaceBetween>}
    </Modal>}
    {removing&&<Modal visible header={`Remove ${removing.name}?`} closeAriaLabel="Close removal confirmation" onDismiss={()=>{if(!busy)setRemoving(null);}} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" disabled={busy} onClick={()=>setRemoving(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={()=>void remove(removing.id)}>Remove authenticator</Button></SpaceBetween></Box>}><SpaceBetween size="m"><Box>You will no longer be able to use {removing.name} to sign in. Removing it signs you out. Make sure you have another sign-in or recovery method available.</Box>{removalError&&<Alert type="error">{removalError}</Alert>}</SpaceBetween></Modal>}
  </SpaceBetween>;
  return embedded?<Container data-testid="webauthn-settings-section" header={<Header variant="h2" counter={`(${credentials.length})`} actions={<Button disabled={creating||busy} onClick={openCreate}>Add authenticator</Button>}>Passkeys and security keys</Header>}>{content}</Container>:<ExpandableSection data-testid="webauthn-settings-section" headerText="Passkeys and security keys">{content}</ExpandableSection>;
}
