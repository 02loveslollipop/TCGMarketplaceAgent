import {settingsInputAttributes} from './inputSemantics';
import {useEffect,useState} from 'react';
import {Alert,Button,Checkbox,Container,ExpandableSection,FormField,Header,Input,SpaceBetween} from '@cloudscape-design/components';
import {api} from './client';

export function RecoveryCodes({codes,onFinish}:{codes:string[];onFinish:()=>void}) {
  const [saved,setSaved]=useState(false);
  function download(){const url=URL.createObjectURL(new Blob([codes.join('\n')+'\n'],{type:'text/plain'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='pokemon-tcg-recovery-codes.txt';anchor.click();URL.revokeObjectURL(url);}
  return <SpaceBetween size="l"><Header variant="h2">Save your recovery codes</Header><Alert type="warning">These codes are shown once. Store them privately. After your password, a recovery code resets all two-factor methods and requires a new authenticator. Recovery never grants direct access.</Alert>
    <div data-testid="recovery-codes-secret" aria-label="Recovery codes"><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{codes.join('\n')}</pre></div>
    <Button data-testid="download-recovery-codes" onClick={download}>Download recovery codes</Button>
    <Checkbox data-testid="recovery-saved-checkbox" checked={saved} onChange={({detail})=>setSaved(detail.checked)}>I have saved these recovery codes</Checkbox>
    <Button data-testid="recovery-finish-button" variant="primary" disabled={!saved} onClick={onFinish}>Finish setup and sign in</Button></SpaceBetween>;
}

export function RecoverySettings({token,onFinish}:{token:string;onFinish:()=>void}) {
  const [remaining,setRemaining]=useState<number>(),[password,setPassword]=useState(''),[codes,setCodes]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{void api<{remaining:number}>('/api/auth/recovery/status',token).then(value=>setRemaining(value.remaining)).catch(error=>setError(error.message));},[token]);
  async function generate(){if(busy||!password)return;setBusy(true);setError('');try{const result=await api<{recovery_codes:string[]}>('/api/auth/recovery/regenerate',token,{method:'POST',body:JSON.stringify({password})});setCodes(result.recovery_codes);}catch(error){setError((error as Error).message);}finally{setPassword('');setBusy(false);}}
  return <Container data-testid="recovery-settings-section" header={<Header variant="h2" description="Manage the codes used to recover access to your account.">Recovery codes</Header>}>{codes.length?<RecoveryCodes codes={codes} onFinish={()=>{setCodes([]);onFinish();}}/>:<SpaceBetween size="m">
    <Alert type="info">{remaining===undefined?'Checking recovery codes…':`${remaining} recovery codes remaining.`} Generating a new set invalidates all previous codes and signs you out.</Alert>
    <FormField label="Current password"><Input data-testid="recovery-current-password" name="current-password" type="password" autoComplete="current-password" nativeInputAttributes={settingsInputAttributes} value={password} disabled={busy} onChange={({detail})=>setPassword(detail.value)}/></FormField>
    <Button data-testid="recovery-regenerate-button" loading={busy} disabled={busy||!password} onClick={()=>void generate()}>Generate new recovery codes</Button>
    {error&&<Alert type="error">{error}</Alert>}</SpaceBetween>}</Container>;
}

export function RecoveryLogin({challengeToken,onAuthenticated,expanded=false,onBusy,inline=false}:{inline?:boolean;expanded?:boolean;onBusy?:(busy:boolean)=>void;challengeToken:string;onAuthenticated:(result:{enrollment_token:string;recovery_reset?:boolean})=>Promise<void>}) {
  const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(){if(busy||!code)return;setBusy(true);onBusy?.(true);setError('');try{await onAuthenticated(await api('/api/auth/recovery/challenge','',{method:'POST',body:JSON.stringify({challenge_token:challengeToken,code})}));}catch(error){setError((error as Error).message);}finally{setCode('');setBusy(false);onBusy?.(false);}}
  const content=<SpaceBetween size="m"><Alert type="warning">Using a recovery code removes all enrolled authenticators, invalidates existing sessions and recovery codes, and requires a new authenticator before you can access the app.</Alert><FormField label="Recovery code"><Input data-testid="recovery-login-code" name="account-recovery-code" nativeInputAttributes={settingsInputAttributes} value={code} disabled={busy} onChange={({detail})=>setCode(detail.value)}/></FormField><Button data-testid="recovery-login-button" variant="primary" formAction={inline?'submit':'none'} disabled={busy||!code} loading={busy} onClick={inline?undefined:()=>void submit()}>Use recovery code</Button>{error&&<Alert type="error">{error}</Alert>}</SpaceBetween>;
  return inline?<form onSubmit={event=>{event.preventDefault();void submit();}}>{content}</form>:<ExpandableSection defaultExpanded={expanded} headerText="Use a recovery code">{content}</ExpandableSection>;
}
