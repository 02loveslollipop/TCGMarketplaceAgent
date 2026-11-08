import {useState} from 'react';
import {Alert,Button,ExpandableSection,FormField,Input,SpaceBetween} from '@cloudscape-design/components';
import {api} from './client';

export function TotpSettings({token,enrolled,onEnrollment}:{token:string;enrolled:boolean;onEnrollment:()=>void}) {
  const [enrollment,setEnrollment]=useState<{secret:string;uri:string}|null>(null),[code,setCode]=useState(''),[error,setError]=useState('');
  async function start() {try {setEnrollment(await api('/api/auth/totp/enrollment',token,{method:'POST'}));}catch(error){setError((error as Error).message);}}
  async function confirm() {try {await api('/api/auth/totp/confirmation',token,{method:'POST',body:JSON.stringify({code})});setEnrollment(null);onEnrollment();}catch(error){setError((error as Error).message);}}
  return <ExpandableSection data-testid="totp-settings-section" headerText="Authenticator settings"><SpaceBetween size="m">
    {error&&<Alert type="error">{error}</Alert>}
    {enrolled?<Alert type="success">Authenticator enrolled.</Alert>:<Button data-testid="totp-enroll-button" onClick={()=>void start()}>Set up authenticator</Button>}
    {enrollment&&<>
      <Alert type="info">Add this account manually in your authenticator. Enter the current code to confirm, then sign in again.</Alert>
      <FormField label="Setup key"><Input data-testid="totp-secret-input" readOnly value={enrollment.secret}/></FormField>
      <FormField label="Authenticator URI"><Input data-testid="totp-uri-input" readOnly value={enrollment.uri}/></FormField>
      <FormField label="Authenticator code"><Input data-testid="totp-code-input" autoComplete="one-time-code" value={code} onChange={({detail})=>setCode(detail.value)}/></FormField>
      <Button data-testid="totp-confirm-button" onClick={()=>void confirm()}>Confirm authenticator</Button>
    </>}
  </SpaceBetween></ExpandableSection>;
}
