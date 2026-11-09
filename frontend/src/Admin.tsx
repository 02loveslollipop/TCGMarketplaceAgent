import {useEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Checkbox,Flashbar,Form,FormField,Header,Input,Modal,Pagination,Select,SpaceBetween,StatusIndicator,Table,TextFilter} from '@cloudscape-design/components';
import {api} from './client';
import {RolePolicies} from './RolePolicies';
import {Overview} from './Overview';
import type {Model} from './contracts';

interface Account {id:string;username:string;role:string;active:boolean}
export type AdminSection='overview'|'accounts'|'models'|'roles';
const suggestions=[{label:'GPT 6 luna',value:'gpt-6-luna',provider:'openai'}, {label:'GPT 6.1 terra',value:'gpt-6.1-terra',provider:'openai'}, {label:'Mistral Medium',value:'mistral-medium-latest',provider:'mistral'}];
const newModel=():Model=>({id:'',label:'',provider:'openai',api_id:'',enabled:false});
const providerName=(provider:string)=>provider==='openai'?'OpenAI':'Mistral';

function ModelEditor({model,existingIds,onClose,onSave,creating}:{model:Model;existingIds:string[];onClose:()=>void;onSave:(model:Model)=>Promise<void>;creating:boolean}) {
  const [draft,setDraft]=useState(model),[busy,setBusy]=useState(false),[submitted,setSubmitted]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false);
  const changed=JSON.stringify(model)!==JSON.stringify(draft);
  const errors={id:!draft.id.trim()?'Enter a registry identifier.':draft.id.length>160?'Use 160 characters or fewer.':creating&&existingIds.includes(draft.id)?'This identifier already exists. Edit that model instead.':'',label:!draft.label.trim()?'Enter a display label.':draft.label.length>160?'Use 160 characters or fewer.':'',api_id:!draft.api_id?'Enter the provider API identifier.':draft.api_id.length>160||!/^[A-Za-z0-9_.:-]+$/.test(draft.api_id)?'Use up to 160 letters, numbers, dots, underscores, colons or hyphens.':''};
  const update=(patch:Partial<Model>)=>{setDraft(previous=>({...previous,...patch}));setError('');};
  function close(){if(busy)return;if(changed)setDiscard(true);else onClose();}
  async function save(){setSubmitted(true);if(Object.values(errors).some(Boolean)||busy)return;setBusy(true);setError('');try{await onSave(draft);onClose();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <Modal visible onDismiss={close} closeAriaLabel="Close model editor" size="medium" header={discard?'Discard model changes?':creating?'Create model policy':`Edit ${model.label}`} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
    {discard?<><Button onClick={()=>setDiscard(false)}>Keep editing</Button><Button variant="primary" onClick={onClose}>Discard changes</Button></>:<><Button variant="link" disabled={busy} onClick={close}>Cancel</Button><Button data-testid="admin-model-save-button" variant="primary" loading={busy} onClick={()=>void save()}>Save model policy</Button></>}
  </SpaceBetween></Box>}>
    {discard?<Box>Your unsaved model settings will be discarded.</Box>:<Form errorText={error}><SpaceBetween size="l">
      <Box color="text-body-secondary">{creating?'Define a model that can be made available in chat.':`Updating model policy: ${model.id}`}</Box>
      {creating&&<FormField label="Requested model preset" description="Optional. A preset fills the identifiers; review them before saving."><Select data-testid="admin-model-preset-select" disabled={busy} selectedOption={suggestions.find(item=>item.value===draft.id)||null} placeholder="Choose a preset or enter your own model" options={suggestions} onChange={({detail})=>{const preset=suggestions.find(item=>item.value===detail.selectedOption.value)!;update({id:preset.value,api_id:preset.value,label:preset.label,provider:preset.provider,enabled:false});}}/></FormField>}
      <FormField label="Registry identifier" description={creating?'A unique identifier for this policy.':'The identifier of the policy being edited.'} errorText={submitted?errors.id:undefined}><Input data-testid="admin-model-id-input" autoFocus={creating} value={draft.id} disabled={busy||!creating} onChange={({detail})=>update({id:detail.value})}/></FormField>
      <FormField label="Display label" description="The name shown in the chat model selector." errorText={submitted?errors.label:undefined}><Input data-testid="admin-model-label-input" autoFocus={!creating} disabled={busy} value={draft.label} onChange={({detail})=>update({label:detail.value})}/></FormField>
      <FormField label="Provider"><Select data-testid="admin-provider-select" disabled={busy} selectedOption={{value:draft.provider,label:providerName(draft.provider)}} options={[{value:'openai',label:'OpenAI'},{value:'mistral',label:'Mistral'}]} onChange={({detail})=>update({provider:detail.selectedOption.value!})}/></FormField>
      <FormField label="Provider API identifier" description="The exact model identifier accepted by the provider." errorText={submitted?errors.api_id:undefined}><Input data-testid="admin-model-api-id-input" disabled={busy} value={draft.api_id} onChange={({detail})=>update({api_id:detail.value})}/></FormField>
      <Checkbox data-testid="admin-model-enabled-checkbox" disabled={busy} checked={draft.enabled} onChange={({detail})=>update({enabled:detail.checked})}>Enabled for agent use</Checkbox>
      <Alert type="info">{draft.enabled?'Saving verifies the API identifier with the provider before making this model available in chat.':'This model will remain unavailable in chat until enabled. The API identifier is verified when enabling it.'}</Alert>
    </SpaceBetween></Form>}
  </Modal>;
}

function AccountEditor({onClose,onSave}:{onClose:()=>void;onSave:(account:{username:string;password:string;role:string})=>Promise<void>}) {
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[role,setRole]=useState('user'),[busy,setBusy]=useState(false),[submitted,setSubmitted]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false);
  const usernameError=!username?'Enter a username.':username.length>160||!/^[A-Za-z0-9_.@-]+$/.test(username)?'Use up to 160 letters, numbers, dots, underscores, @ signs or hyphens.':'';
  const passwordError=password.length<12||password.length>256?'Use a password between 12 and 256 characters.':'';
  function close(){if(busy)return;if(username||password||role!=='user')setDiscard(true);else onClose();}
  async function save(){setSubmitted(true);if(usernameError||passwordError||busy)return;setBusy(true);setError('');try{await onSave({username,password,role});setPassword('');onClose();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <Modal visible onDismiss={close} closeAriaLabel="Close account form" header={discard?'Discard account changes?':'Create account'} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
    {discard?<><Button onClick={()=>setDiscard(false)}>Keep editing</Button><Button variant="primary" onClick={onClose}>Discard changes</Button></>:<><Button variant="link" disabled={busy} onClick={close}>Cancel</Button><Button data-testid="admin-account-create-button" variant="primary" loading={busy} onClick={()=>void save()}>Create account</Button></>}
  </SpaceBetween></Box>}>
    {discard?<Box>Your unsaved account details will be discarded.</Box>:<Form errorText={error}><SpaceBetween size="l">
      <FormField label="New username" errorText={submitted?usernameError:undefined}><Input data-testid="admin-username-input" autoFocus disabled={busy} autoComplete="off" value={username} onChange={({detail})=>setUsername(detail.value)}/></FormField>
      <FormField label="Initial password" description="At least 12 characters. Share privately with the account holder." errorText={submitted?passwordError:undefined}><Input data-testid="admin-password-input" disabled={busy} type="password" autoComplete="new-password" value={password} onChange={({detail})=>setPassword(detail.value)}/></FormField>
      <FormField label="Role" description="Users can chat. Administrators can also manage accounts and model policies."><Select data-testid="admin-role-select" disabled={busy} selectedOption={{value:role,label:role==='admin'?'Administrator':'User'}} options={[{value:'user',label:'User'},{value:'admin',label:'Administrator'}]} onChange={({detail})=>setRole(detail.selectedOption.value!)}/></FormField>
      <Alert type="info">The account holder will set up two-factor authentication at their first sign-in.</Alert>
    </SpaceBetween></Form>}
  </Modal>;
}

export function Admin({token,section='models',onNavigate,onSessionChange}:{token:string;section?:AdminSection;onNavigate?:(section:AdminSection)=>void;onSessionChange?:()=>void}) {
  const [accounts,setAccounts]=useState<Account[]>([]),[models,setModels]=useState<Model[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [editing,setEditing]=useState<Model|null>(null),[creatingModel,setCreatingModel]=useState(false),[creatingAccount,setCreatingAccount]=useState(false);
  const [rolesVisited,setRolesVisited]=useState(section==='roles');
  useEffect(()=>{if(section==='roles')setRolesVisited(true);},[section]);
  const [roleAccount,setRoleAccount]=useState<Account|null>(null),[newRole,setNewRole]=useState('user'),[roleBusy,setRoleBusy]=useState(false),[roleError,setRoleError]=useState('');
  const [filter,setFilter]=useState(''),[page,setPage]=useState(1);
  const editorTrigger=useRef<HTMLElement|null>(null);
  useEffect(()=>{if(!editing&&!creatingAccount&&!roleAccount)editorTrigger.current?.focus();},[editing,creatingAccount,roleAccount]);
  async function refresh(){const [accounts,models]=await Promise.all([api<Account[]>('/api/admin/accounts',token),api<Model[]>('/api/admin/models',token)]);setAccounts(accounts);setModels(models);}
  useEffect(()=>{if(section==='overview'||section==='roles')return;setError('');setLoading(true);void refresh().catch(error=>setError(error.message)).finally(()=>setLoading(false));},[token,section]);
  useEffect(()=>{setFilter('');setPage(1);},[section]);
  // A successful mutation stays successful if the subsequent list refresh fails.
  async function reload(){try{await refresh();}catch{setError('Your change was saved, but the list could not be refreshed. Refresh the page to see the latest data.');}}
  const filteredModels=models.filter(model=>[model.label,model.provider,model.api_id,model.enabled?'enabled':'disabled'].some(value=>value.toLowerCase().includes(filter.toLowerCase())));
  const filteredAccounts=accounts.filter(account=>[account.username,account.role,account.active?'active':'disabled'].some(value=>value.toLowerCase().includes(filter.toLowerCase())));
  const rows=section==='accounts'?filteredAccounts:filteredModels;
  const currentPage=Math.min(page,Math.max(1,Math.ceil(rows.length/10)));
  const empty=<Box textAlign="center" padding="l"><SpaceBetween size="s"><Box fontWeight="bold">{filter?'No matches':section==='accounts'?'No accounts':'No model policies'}</Box><Box color="text-body-secondary">{filter?'Try another search.':section==='accounts'?'Create an account to give someone access.':'Create a model policy to configure the chat selector.'}</Box>{filter&&<Button onClick={()=>{setFilter('');setPage(1);}}>Clear filter</Button>}</SpaceBetween></Box>;
  const tableFilter=<TextFilter filteringText={filter} filteringPlaceholder={section==='accounts'?'Find accounts':'Find models'} filteringAriaLabel={section==='accounts'?'Find accounts':'Find models'} onChange={({detail})=>{setFilter(detail.filteringText);setPage(1);}} countText={`${rows.length} ${rows.length===1?'match':'matches'}`}/>;
  const pagination=<Pagination currentPageIndex={currentPage} pagesCount={Math.max(1,Math.ceil(rows.length/10))} onChange={({detail})=>setPage(detail.currentPageIndex)} ariaLabels={{nextPageLabel:'Next page',previousPageLabel:'Previous page',pageLabel:page=>`Page ${page}`}}/>;
  return <SpaceBetween size="l">
    <div hidden={section==='roles'}><SpaceBetween size="l">
    {section!=='overview'&&<Header variant="h1" description={section==='accounts'?'Manage who can use this private workspace.':'Control which models appear in chat and the provider identifiers they use.'} actions={<Button variant="primary" onClick={()=>{editorTrigger.current=document.activeElement as HTMLElement;setNotice('');if(section==='accounts')setCreatingAccount(true);else{setCreatingModel(true);setEditing(newModel());}}}>{section==='accounts'?'Create account':'Create model policy'}</Button>}>{section==='accounts'?'Accounts':'Model policies'}</Header>}
    {section!=='overview'&&error&&<Alert type="error" dismissible onDismiss={()=>setError('')}>{error}</Alert>}
    <Flashbar items={notice?[{id:'admin-success',type:'success',content:notice,dismissible:true,dismissLabel:'Dismiss notification',onDismiss:()=>setNotice('')}]:[]}/>
    {section==='overview'?<Overview token={token} onNavigate={onNavigate}/>:section==='accounts'?<Table data-testid="admin-accounts-table" loading={loading} loadingText="Loading accounts" trackBy="id" header={<Header variant="h2" counter={`(${accounts.length})`}>Accounts</Header>} filter={tableFilter} pagination={pagination} items={filteredAccounts.slice((currentPage-1)*10,currentPage*10)} empty={empty} columnDefinitions={[
      {id:'username',header:'Username',cell:row=>row.username},{id:'role',header:'Role',cell:row=>row.role==='admin'?'Administrator':'User'},{id:'active',header:'State',cell:row=><StatusIndicator type={row.active?'success':'stopped'}>{row.active?'Active':'Disabled'}</StatusIndicator>},
      {id:'actions',header:'Actions',cell:row=><Button variant="inline-link" ariaLabel={`Change role for ${row.username}`} onClick={()=>{editorTrigger.current=document.activeElement as HTMLElement;setRoleAccount(row);setNewRole(row.role);setRoleError('');}}>Change role</Button>}
    ]}/>:<>
      <Table data-testid="admin-models-table" stickyColumns={{first:1,last:1}} loading={loading} loadingText="Loading model policies" trackBy="id" header={<Header variant="h2" counter={`(${models.length})`} description="Choose Edit on a row to update that specific policy.">Allowed models</Header>} filter={tableFilter} pagination={pagination} items={filteredModels.slice((currentPage-1)*10,currentPage*10)} empty={empty} columnDefinitions={[
        {id:'label',header:'Model',cell:row=><SpaceBetween size="xxs"><Box fontWeight="bold">{row.label}</Box><Box color="text-body-secondary" fontSize="body-s">{row.id}</Box></SpaceBetween>},
        {id:'provider',header:'Provider',cell:row=>providerName(row.provider)},{id:'api',header:'API identifier',cell:row=>row.api_id},
        {id:'state',header:'Availability',cell:row=><StatusIndicator type={row.enabled?'success':'stopped'}>{row.enabled?'Enabled':'Disabled'}</StatusIndicator>},
        {id:'verified',header:'Last verified',cell:row=>row.verified_at?new Date(row.verified_at).toLocaleString():'Unverified'},
        {id:'edit',header:'Actions',cell:row=><Button data-testid="admin-model-edit-button" variant="inline-link" ariaLabel={`Edit ${row.label}`} onClick={()=>{editorTrigger.current=document.activeElement as HTMLElement;setNotice('');setCreatingModel(false);setEditing(row);}}>Edit</Button>}
      ]}/>
      <Box color="text-body-secondary">Enabling a policy verifies the API identifier with its provider. Invocation failures are reported in chat.</Box>
    </>}
    </SpaceBetween></div>
    <div hidden={section!=='roles'}>{rolesVisited&&<RolePolicies token={token}/>}</div>
    {roleAccount&&<Modal visible header={`Change role for ${roleAccount.username}`} closeAriaLabel="Close role editor" onDismiss={()=>{if(!roleBusy)setRoleAccount(null);}} footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" disabled={roleBusy} onClick={()=>setRoleAccount(null)}>Cancel</Button><Button variant="primary" loading={roleBusy} disabled={newRole===roleAccount.role} onClick={()=>{if(roleBusy)return;setRoleBusy(true);setRoleError('');void api<Account&{sign_in_again:boolean}>(`/api/admin/accounts/${roleAccount.id}/role`,token,{method:'PUT',body:JSON.stringify({role:newRole})}).then(async result=>{setRoleAccount(null);if(result.sign_in_again){onSessionChange?.();return;}setNotice(`${result.username} role changed to ${result.role==='admin'?'Administrator':'User'}. Existing sessions revoked.`);await reload();}).catch(error=>setRoleError(error.message)).finally(()=>setRoleBusy(false));}}>Save role</Button></SpaceBetween></Box>}><SpaceBetween size="l"><FormField label="Account role"><Select selectedOption={{value:newRole,label:newRole==='admin'?'Administrator':'User'}} options={[{value:'user',label:'User'},{value:'admin',label:'Administrator'}]} onChange={({detail})=>setNewRole(detail.selectedOption.value!)} disabled={roleBusy}/></FormField><Alert type="info">Changing a role revokes the account's existing sessions. The last active administrator cannot be demoted.</Alert>{roleError&&<Alert type="error">{roleError}</Alert>}</SpaceBetween></Modal>}
    {editing&&<ModelEditor key={`${creatingModel}-${editing.id}`} model={editing} existingIds={models.map(model=>model.id)} creating={creatingModel} onClose={()=>setEditing(null)} onSave={async model=>{await api(`/api/admin/models/${encodeURIComponent(model.id)}`,token,{method:'PUT',body:JSON.stringify({label:model.label,provider:model.provider,api_id:model.api_id,enabled:model.enabled})});setNotice(`${model.label} model policy saved. ${model.enabled?'Enabled in chat.':'Disabled in chat.'}`);await reload();}}/>}
    {creatingAccount&&<AccountEditor onClose={()=>setCreatingAccount(false)} onSave={async account=>{await api('/api/admin/accounts',token,{method:'POST',body:JSON.stringify(account)});setNotice(`Account ${account.username} created.`);await reload();}}/>}
  </SpaceBetween>;
}
