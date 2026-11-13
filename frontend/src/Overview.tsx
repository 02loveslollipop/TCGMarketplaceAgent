import {useEffect,useState} from 'react';
import {Alert,Box,Button,ColumnLayout,Container,Grid,Header,KeyValuePairs,SpaceBetween,StatusIndicator,Table} from '@cloudscape-design/components';
import {api} from './client';
import type {AdminSection} from './Admin';
import type {Model,Session} from './contracts';
import {permits} from './iam';
import {Consumption} from './Consumption';

interface Account {id:string;username:string;role:string;role_name?:string;administrative_access?:boolean;active:boolean}
interface RolePolicy {role:string;builtin_key?:string|null;role_name?:string;daily_token_limit:number;allowed_model_ids:string[]|null;reset_timezone:string}
interface Resource<T> {data?:T[];loading:boolean;error?:string}
const pending={loading:true};
const roleName=(role:string)=>role==='admin'?'Administrator':'User';
const providerName=(provider:string)=>provider==='openai'?'OpenAI':provider==='mistral'?'Mistral':provider;
const failure=(resource:Resource<unknown>,label:string)=>resource.error?<Alert type="error" header={`${label} unavailable`}>{resource.error} Use Refresh to try again.</Alert>:null;

export function Overview({token,onNavigate,session}:{token:string;session?:Session;onNavigate?:(section:AdminSection)=>void}) {
  const [accounts,setAccounts]=useState<Resource<Account>>(pending),[models,setModels]=useState<Resource<Model>>(pending),[policies,setPolicies]=useState<Resource<RolePolicy>>(pending);
  const [revision,setRevision]=useState(0),[updated,setUpdated]=useState<Date|null>(null);
  useEffect(()=>{
    let active=true;
    setAccounts(pending);setModels(pending);setPolicies(pending);setUpdated(null);
    async function load<T>(path:string,set:(resource:Resource<T>)=>void,action:string){
      if(!permits(session,action)){set({loading:false,error:"Your role does not allow reading this resource."});return false;}
      try{const data=await api<T[]>(path,token);if(active)set({data,loading:false});return true;}
      catch(error){if(active)set({loading:false,error:(error as Error).message});return false;}
    }
    void Promise.all([load('/api/admin/accounts',setAccounts,'admin:accounts:read'),load('/api/admin/models',setModels,'admin:models:read'),load('/api/admin/role-policies',setPolicies,'iam:roles:read')]).then(results=>{if(active&&results.every(Boolean))setUpdated(new Date());});
    return()=>{active=false;};
  },[token,revision,session]);
  const loading=accounts.loading||models.loading||policies.loading;
  const activeAccounts=accounts.data?.filter(account=>account.active);
  const enabled=models.data?.filter(model=>model.enabled);
  const availableModels=(policy:RolePolicy)=>enabled?.filter(model=>policy.allowed_model_ids===null||policy.allowed_model_ids.includes(model.id)).length;
  const usableRoles=policies.data&&enabled?policies.data.filter(policy=>policy.daily_token_limit>0&&(availableModels(policy)??0)>0):undefined;
  const count=(value:number|undefined,busy:boolean)=>busy?<StatusIndicator type="loading">Loading</StatusIndicator>:value===undefined?<StatusIndicator type="error">Unavailable</StatusIndicator>:<Box fontSize="display-l" fontWeight="bold">{value}</Box>;
  const providers=[...new Set(models.data?.map(model=>model.provider))].sort().map(provider=>({provider,models:models.data!.filter(model=>model.provider===provider)}));
  const unverified=enabled?.filter(model=>!model.verified_at);
  const accountIssue=activeAccounts?.every(account=>!(account.administrative_access??account.role==='admin'));
  const modelIssue=enabled?.length===0||!!unverified?.length;
  const roleIssues=policies.data&&enabled?policies.data.filter(policy=>policy.daily_token_limit===0||availableModels(policy)===0):undefined;
  const missingRoles=policies.data?['user','admin'].filter(role=>!policies.data!.some(policy=>(policy.builtin_key??policy.role)===role)):[];
  const canAssess=!!accounts.data&&!!models.data&&!!policies.data;
  return <SpaceBetween size="l">
    <Header variant="h1" description="Monitor workspace access, model availability, and daily allowances." actions={<Button iconName="refresh" loading={loading} onClick={()=>setRevision(value=>value+1)}>Refresh</Button>}>Overview</Header>
    <Consumption compact refreshKey={revision} token={token} session={session} onExplore={()=>onNavigate?.('consumption')}/>
    <Container header={<Header variant="h2" description={updated?`Last refreshed ${updated.toLocaleTimeString()}.`:'Current workspace configuration.'}>Workspace overview</Header>}>
      <ColumnLayout columns={4} variant="text-grid">
        <SpaceBetween size="xs"><Box color="text-body-secondary">Active accounts</Box><div data-testid="overview-active-accounts">{count(activeAccounts?.length,accounts.loading)}</div><Box color="text-body-secondary">{accounts.data?`${accounts.data.length} total accounts`:'Accounts with workspace access.'}</Box>{permits(session,'admin:accounts:read')&&<Button variant="inline-link" onClick={()=>onNavigate?.('accounts')}>View accounts</Button>}</SpaceBetween>
        <SpaceBetween size="xs"><Box color="text-body-secondary">Enabled models</Box><div data-testid="overview-enabled-models">{count(enabled?.length,models.loading)}</div><Box color="text-body-secondary">{models.data?`${models.data.length} registered model policies`:'Models enabled globally for chat.'}</Box>{permits(session,'admin:models:read')&&<Button variant="inline-link" onClick={()=>onNavigate?.('models')}>View model policies</Button>}</SpaceBetween>
        <SpaceBetween size="xs"><Box color="text-body-secondary">Roles with chat access</Box><div data-testid="overview-usable-roles">{count(usableRoles?.length,policies.loading||models.loading)}</div><Box color="text-body-secondary">A positive quota and an enabled model.</Box>{permits(session,'iam:roles:read')&&<Button variant="inline-link" onClick={()=>onNavigate?.('roles')}>Manage role access</Button>}</SpaceBetween>
        <SpaceBetween size="xs"><Box color="text-body-secondary">Activity and legality</Box><div data-testid="overview-activity-link"><Box fontSize="display-l" fontWeight="bold">Audit</Box></div><Box color="text-body-secondary">Execution traces and legality sync.</Box>{permits(session,'admin:activity:read')&&<Button variant="inline-link" onClick={()=>onNavigate?.('activity')}>View activity logs</Button>}</SpaceBetween>
      </ColumnLayout>
    </Container>
    <Grid gridDefinition={[{colspan:{default:12,s:8}},{colspan:{default:12,s:4}}]}>
      <Table wrapLines ariaLabels={{tableLabel:'Model availability by provider'}} variant="container" loading={models.loading} loadingText="Loading model availability" items={providers} trackBy="provider" header={<Header variant="h2" description="Enabled / registered models by provider. Unverified counts apply to enabled models.">Model availability</Header>} empty={models.error?failure(models,'Model policies'):<Box textAlign="center" padding="m">No model policies. Add a model policy to configure chat.</Box>} columnDefinitions={[
        {id:'provider',header:'Provider',isRowHeader:true,cell:row=>providerName(row.provider)},
        {id:'enabled',header:'Enabled',cell:row=><StatusIndicator type={row.models.some(model=>model.enabled)?'success':'stopped'}>{row.models.filter(model=>model.enabled).length} / {row.models.length}</StatusIndicator>},
        {id:'verification',header:'Unverified',cell:row=>{const missing=row.models.filter(model=>model.enabled&&!model.verified_at).length;return <StatusIndicator type={missing?'warning':'info'}>{missing}</StatusIndicator>;}}
      ]}/>
      <Container header={<Header variant="h2">Account access</Header>}>
        {accounts.loading?<StatusIndicator type="loading">Loading accounts</StatusIndicator>:accounts.error?failure(accounts,'Accounts'):<KeyValuePairs items={[
          {label:'Active administrators',value:activeAccounts?.filter(account=>(account.administrative_access??account.role==='admin')).length},
          {label:'Active users',value:activeAccounts?.filter(account=>!(account.administrative_access??account.role==='admin')).length},
          {label:'Disabled accounts',value:accounts.data!.filter(account=>!account.active).length}
        ]}/>}
      </Container>
    </Grid>
    <Grid gridDefinition={[{colspan:{default:12,s:8}},{colspan:{default:12,s:4}}]}>
      <Container data-testid="overview-role-quotas" header={<Header variant="h2" description="Per principal, input + output tokens. Resets at midnight Japan time.">Role access and quotas</Header>}>
        {policies.loading?<StatusIndicator type="loading">Loading daily allowances</StatusIndicator>:policies.error?failure(policies,'Role policies'):!policies.data!.length?<Box>No role policies returned. Review role access before using chat.</Box>:<ColumnLayout columns={2} variant="text-grid">{policies.data!.map(policy=><SpaceBetween key={policy.role} size="s">
          <Box variant="h3">{(policy.role_name||roleName(policy.role))}</Box>
          <KeyValuePairs items={[
            {label:'Daily tokens per principal',value:policy.daily_token_limit.toLocaleString()},
            {label:'Chat access',value:models.loading?<StatusIndicator type="loading">Loading models</StatusIndicator>:models.error?<StatusIndicator type="error">Unknown</StatusIndicator>:<StatusIndicator type={policy.daily_token_limit>0&&(availableModels(policy)??0)>0?'success':'stopped'}>{policy.daily_token_limit===0?'Blocked by quota':`${availableModels(policy)} enabled models`}</StatusIndicator>}
          ]}/>
        </SpaceBetween>)}</ColumnLayout>}
      </Container>
      <Container header={<Header variant="h2">Configuration checks</Header>}><SpaceBetween size="m">
        {loading?<StatusIndicator type="loading">Checking configuration</StatusIndicator>:!canAssess?<StatusIndicator type="warning">Some checks unavailable. Refresh to retry failed requests.</StatusIndicator>:<>
          <StatusIndicator type={accountIssue?'error':'success'}>{accountIssue?'No active administrator':'Administrator access configured'}</StatusIndicator>
          <StatusIndicator type={modelIssue?'warning':'success'}>{enabled!.length===0?'No models enabled':unverified!.length?`${unverified!.length} enabled models without verification`:'Enabled models have verification records'}</StatusIndicator>
          <StatusIndicator type={roleIssues!.length||missingRoles.length?'warning':'success'}>{missingRoles.length?`${missingRoles.map(roleName).join(', ')} policies missing`:roleIssues!.length?`${roleIssues!.map(policy=>(policy.role_name||roleName(policy.role))).join(', ')} chat access blocked`:'All roles have chat access'}</StatusIndicator>
        </>}
        <Box fontSize="body-s" color="text-body-secondary">Configuration checks use saved settings. Provider availability is checked when a model is enabled or used.</Box>
      </SpaceBetween></Container>
    </Grid>
    <Container header={<Header variant="h2">Workspace guidance</Header>}><ColumnLayout columns={3} variant="text-grid">
      <SpaceBetween size="xs"><Box variant="h3">Account security</Box><Box>New account holders enroll an authenticator at sign-in. Manage your own authenticators in Account security.</Box></SpaceBetween>
      <SpaceBetween size="xs"><Box variant="h3">Model verification</Box><Box>Enabling a model verifies its API identifier with the provider. Disabled models stay unavailable in chat.</Box></SpaceBetween>
      <SpaceBetween size="xs"><Box variant="h3">Daily quotas</Box><Box>Each human account and API principal has its own allowance. In-flight responses can finish beyond the remaining balance. Adjust allowances in Role access and quotas.</Box></SpaceBetween>
    </ColumnLayout></Container>
  </SpaceBetween>;
}
