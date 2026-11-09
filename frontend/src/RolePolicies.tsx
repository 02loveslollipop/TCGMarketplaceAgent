import {useEffect,useState} from 'react';
import {Alert,Box,Button,Checkbox,Container,Flashbar,Form,FormField,Header,Input,KeyValuePairs,Multiselect,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import {api} from './client';
import type {Model} from './contracts';
interface RolePolicy {role:'user'|'admin';daily_token_limit:number;allowed_model_ids:string[]|null;reset_timezone:string}
const name=(role:string)=>role==='admin'?'Administrator':'User';
export function RolePolicies({token}:{token:string}){
 const [policies,setPolicies]=useState<RolePolicy[]>([]),[models,setModels]=useState<Model[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [editing,setEditing]=useState<RolePolicy|null>(null),[limit,setLimit]=useState(''),[inherit,setInherit]=useState(true),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[submitted,setSubmitted]=useState(false),[discard,setDiscard]=useState(false);
 useEffect(()=>{void Promise.all([api<RolePolicy[]>('/api/admin/role-policies',token),api<Model[]>('/api/admin/models',token)]).then(([roles,models])=>{setPolicies(roles);setModels(models);}).catch(error=>setError(error.message));},[token]);
 const changed=!!editing&&(limit!==String(editing.daily_token_limit)||JSON.stringify(inherit?null:[...selected].sort())!==JSON.stringify(editing.allowed_model_ids===null?null:[...editing.allowed_model_ids].sort()));
 useEffect(()=>{if(!changed)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[changed]);
 function edit(policy:RolePolicy){setEditing(policy);setLimit(String(policy.daily_token_limit));setInherit(policy.allowed_model_ids===null);setSelected(policy.allowed_model_ids||[]);setError('');setNotice('');setSubmitted(false);setDiscard(false);}
 const invalid=!/^\d+$/.test(limit)||!Number.isSafeInteger(Number(limit))||Number(limit)>1_000_000_000;
 async function save(){setSubmitted(true);if(invalid||!editing||busy)return;setBusy(true);setError('');try{const saved=await api<RolePolicy>(`/api/admin/role-policies/${editing.role}`,token,{method:'PUT',body:JSON.stringify({daily_token_limit:Number(limit),allowed_model_ids:inherit?null:selected})});setPolicies(previous=>previous.map(row=>row.role===saved.role?saved:row));setNotice(`${name(saved.role)} access policy saved.`);setEditing(null);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <SpaceBetween size="l">
   <Header variant="h1" description="Set each role’s model access and daily token allowance per user.">Role access and quotas</Header>
   <Alert type="info">Input and output tokens from all model calls count toward each user's quota. Quotas reset at midnight Japan time. In-flight responses may finish beyond the remaining balance. Only globally enabled models can be used.</Alert>
   <Flashbar items={notice?[{id:'role-saved',type:'success',content:notice,dismissible:true,dismissLabel:'Dismiss role notification',onDismiss:()=>setNotice('')}]:[]}/>
   {error&&!editing&&<Alert type="error">{error}</Alert>}
   {!policies.length&&!error&&<StatusIndicator type="loading">Loading role policies</StatusIndicator>}
   {policies.map(policy=><Container key={policy.role} header={<Header variant="h2" actions={editing?.role!==policy.role&&<Button disabled={!!editing} onClick={()=>edit(policy)}>Edit {name(policy.role)} policy</Button>}>{name(policy.role)}</Header>}>
     {editing?.role!==policy.role?<KeyValuePairs columns={2} items={[{label:'Daily quota per user',value:`${policy.daily_token_limit.toLocaleString()} tokens`},{label:'Model access',value:policy.allowed_model_ids===null?'All globally enabled models':policy.allowed_model_ids.length?policy.allowed_model_ids.map(id=>models.find(model=>model.id===id)?.label||id).join(', '):'No models'}]}/>:<Form errorText={error}><SpaceBetween size="l">
       <FormField label="Daily token quota per user" description="Input + output tokens. Enter 0 to block new model calls for this role." errorText={submitted&&invalid?'Enter a whole number between 0 and 1,000,000,000.':undefined}><Input data-testid="role-quota-input" autoFocus disabled={busy} value={limit} onChange={({detail})=>setLimit(detail.value)}/></FormField>
       <Checkbox checked={inherit} disabled={busy} onChange={({detail})=>setInherit(detail.checked)}>Use all globally enabled models</Checkbox>
       {!inherit&&<FormField label="Models enabled for this role" description="A model must also be enabled in Model policies. An empty selection blocks all models."><Multiselect data-testid="role-model-select" disabled={busy} selectedOptions={selected.map(id=>({value:id,label:models.find(model=>model.id===id)?.label||id}))} options={models.map(model=>({value:model.id,label:model.label,description:model.enabled?'Globally enabled':'Globally disabled'}))} placeholder="Choose allowed models" onChange={({detail})=>setSelected(detail.selectedOptions.map(option=>option.value!))}/></FormField>}
       {discard?<Alert type="warning" header="Discard policy changes?"><SpaceBetween direction="horizontal" size="s"><Button onClick={()=>setDiscard(false)}>Keep editing</Button><Button onClick={()=>{setEditing(null);setDiscard(false);}}>Discard changes</Button></SpaceBetween></Alert>:<SpaceBetween direction="horizontal" size="s"><Button variant="primary" loading={busy} onClick={()=>void save()}>Save role policy</Button><Button disabled={busy} onClick={()=>changed?setDiscard(true):setEditing(null)}>Cancel</Button></SpaceBetween>}
     </SpaceBetween></Form>}
   </Container>)}
   <Box color="text-body-secondary">Each account has its own allowance. Changing a role does not reset the account’s usage for the day. A quota limits usage; it does not by itself prevent prompt injection.</Box>
 </SpaceBetween>;
}
