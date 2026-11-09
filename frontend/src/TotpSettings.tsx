import {useState} from 'react';
import {Alert,Button,Container,Header,StatusIndicator,ExpandableSection,FormField,Input,SpaceBetween} from '@cloudscape-design/components';
import {api} from './client';
import {TotpSetup} from './TotpSetup';

export function TotpSettings({token,enrolled,onEnrollment,embedded=false}:{token:string;enrolled:boolean;onEnrollment:()=>void;embedded?:boolean}) {
  const [enrollment,setEnrollment]=useState<{secret:string;uri:string}|null>(null),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[discard,setDiscard]=useState(false);
  async function start() {if(busy)return;setBusy(true);setError('');try {setEnrollment(await api('/api/auth/totp/enrollment',token,{method:'POST'}));}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  async function confirm() {if(busy||!code)return;setBusy(true);setError('');try {await api('/api/auth/totp/confirmation',token,{method:'POST',body:JSON.stringify({code})});setEnrollment(null);onEnrollment();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  const content=<SpaceBetween size="m">
    {error&&<Alert type="error">{error}</Alert>}
    {enrolled?<StatusIndicator type="success">Authenticator enrolled.</StatusIndicator>:!enrollment&&<Button data-testid="totp-enroll-button" loading={busy} onClick={()=>void start()}>Set up authenticator</Button>}
    {enrollment&&<>
      <TotpSetup {...enrollment}/>
      <FormField label="Authenticator code"><Input data-testid="totp-code-input" autoComplete="one-time-code" value={code} disabled={busy} onChange={({detail})=>setCode(detail.value)}/></FormField>
      <Button data-testid="totp-confirm-button" variant="primary" loading={busy} disabled={busy||!code} onClick={()=>void confirm()}>Confirm authenticator</Button>
      {!discard?<Button disabled={busy} onClick={()=>setDiscard(true)}>Cancel setup</Button>:<Alert type="warning" header="Discard authenticator setup?"><SpaceBetween size="s"><span>The unconfirmed QR code and setup key will be cleared.</span><SpaceBetween direction="horizontal" size="s"><Button onClick={()=>setDiscard(false)}>Keep setting up</Button><Button onClick={()=>{setEnrollment(null);setCode('');setDiscard(false);setError('');}}>Discard setup</Button></SpaceBetween></SpaceBetween></Alert>}
    </>}
  </SpaceBetween>;
  return embedded?<Container data-testid="totp-settings-section" header={<Header variant="h2" description="Add an authenticator app to this account and verify its code before it becomes active.">Authenticator app</Header>}>{content}</Container>:<ExpandableSection data-testid="totp-settings-section" headerText="Authenticator settings">{content}</ExpandableSection>;
}
