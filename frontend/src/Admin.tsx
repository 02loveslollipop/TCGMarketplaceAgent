import {useEffect,useState} from 'react';
import {Alert,Button,Checkbox,Container,FormField,Header,Input,Select,SpaceBetween,StatusIndicator,Table} from '@cloudscape-design/components';
import {api} from './client';
import type {Model} from './contracts';

interface Account {id:string;username:string;role:string;active:boolean}
const suggestions=[{label:'GPT 6 luna',value:'gpt-6-luna',provider:'openai'}, {label:'GPT 6.1 terra',value:'gpt-6.1-terra',provider:'openai'}, {label:'Mistral Medium',value:'mistral-medium-latest',provider:'mistral'}];

export function Admin({token}:{token:string}) {
  const [accounts,setAccounts]=useState<Account[]>([]),[models,setModels]=useState<Model[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[role,setRole]=useState('user');
  const [id,setId]=useState('gpt-6-luna'),[label,setLabel]=useState('GPT 6 luna'),[provider,setProvider]=useState('openai'),[apiId,setApiId]=useState('gpt-6-luna'),[enabled,setEnabled]=useState(false);
  async function refresh(){const [accounts,models]=await Promise.all([api<Account[]>('/api/admin/accounts',token),api<Model[]>('/api/admin/models',token)]);setAccounts(accounts);setModels(models);}
  useEffect(()=>{void refresh().catch(error=>setError(error.message));},[token]);
  async function mutate(operation:()=>Promise<unknown>,message:string) {setBusy(true);setError('');setNotice('');try{await operation();await refresh();setNotice(message);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  function edit(model:Model){setId(model.id);setLabel(model.label);setProvider(model.provider);setApiId(model.api_id);setEnabled(model.enabled);}
  return <SpaceBetween size="l">
    <Header variant="h1">Agent administration</Header>
    {error&&<Alert type="error">{error}</Alert>}{notice&&<Alert type="success">{notice}</Alert>}
    <Container header={<Header variant="h2">Accounts</Header>}><SpaceBetween size="m">
      <Table data-testid="admin-accounts-table" items={accounts} columnDefinitions={[{id:'username',header:'Username',cell:row=>row.username},{id:'role',header:'Role',cell:row=>row.role},{id:'active',header:'State',cell:row=>row.active?'Active':'Disabled'}]}/>
      <FormField label="New username"><Input data-testid="admin-username-input" value={username} onChange={({detail})=>setUsername(detail.value)}/></FormField>
      <FormField label="Initial password" description="At least 12 characters. Share privately with the account holder."><Input data-testid="admin-password-input" type="password" autoComplete="new-password" value={password} onChange={({detail})=>setPassword(detail.value)}/></FormField>
      <FormField label="Role"><Select data-testid="admin-role-select" selectedOption={{value:role,label:role}} options={[{value:'user',label:'user'},{value:'admin',label:'admin'}]} onChange={({detail})=>setRole(detail.selectedOption.value!)}/></FormField>
      <Button data-testid="admin-account-create-button" loading={busy} disabled={!username||password.length<12} onClick={()=>void mutate(async()=>{await api('/api/admin/accounts',token,{method:'POST',body:JSON.stringify({username,password,role})});setUsername('');setPassword('');},'Account created.')}>Create account</Button>
    </SpaceBetween></Container>
    <Container header={<Header variant="h2">Allowed models</Header>}><SpaceBetween size="m">
      <Alert type="info">Labels and provider API identifiers are separate. Enabling a model verifies its API identifier with the provider. Invocation failures, including rate limits, are shown without switching models.</Alert>
      <Table data-testid="admin-models-table" items={models} columnDefinitions={[
        {id:'label',header:'Label',cell:row=>row.label},{id:'provider',header:'Provider',cell:row=>row.provider},{id:'api',header:'API identifier',cell:row=>row.api_id},
        {id:'state',header:'Status',cell:row=><StatusIndicator type={row.enabled?'success':'stopped'}>{row.enabled?'Enabled':'Disabled'}</StatusIndicator>},
        {id:'verified',header:'Verified',cell:row=>row.verified_at?new Date(row.verified_at).toLocaleString():'Unverified'},
        {id:'edit',header:'Edit',cell:row=><Button data-testid="admin-model-edit-button" onClick={()=>edit(row)}>Edit {row.label}</Button>}
      ]}/>
      <FormField label="Requested model preset"><Select data-testid="admin-model-preset-select" selectedOption={null} placeholder="Choose a requested model or enter identifiers below" options={suggestions} onChange={({detail})=>{const model=suggestions.find(item=>item.value===detail.selectedOption.value)!;setId(model.value);setApiId(model.value);setLabel(model.label);setProvider(model.provider);setEnabled(false);}}/></FormField>
      <FormField label="Registry identifier"><Input data-testid="admin-model-id-input" value={id} onChange={({detail})=>setId(detail.value)}/></FormField>
      <FormField label="Display label"><Input data-testid="admin-model-label-input" value={label} onChange={({detail})=>setLabel(detail.value)}/></FormField>
      <FormField label="Provider"><Select data-testid="admin-provider-select" selectedOption={{value:provider,label:provider}} options={[{value:'openai',label:'openai'},{value:'mistral',label:'mistral'}]} onChange={({detail})=>setProvider(detail.selectedOption.value!)}/></FormField>
      <FormField label="Provider API identifier"><Input data-testid="admin-model-api-id-input" value={apiId} onChange={({detail})=>setApiId(detail.value)}/></FormField>
      <Checkbox data-testid="admin-model-enabled-checkbox" checked={enabled} onChange={({detail})=>setEnabled(detail.checked)}>Enabled for agent use</Checkbox>
      <Button data-testid="admin-model-save-button" variant="primary" loading={busy} disabled={!id||!label||!apiId} onClick={()=>void mutate(()=>api(`/api/admin/models/${encodeURIComponent(id)}`,token,{method:'PUT',body:JSON.stringify({label,provider,api_id:apiId,enabled})}),'Model policy saved.')}>Save model policy</Button>
    </SpaceBetween></Container>
  </SpaceBetween>;
}
