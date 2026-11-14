import {render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {IAMAccess} from '../IAMAccess';
import {evaluateAgentCapability,permits} from '../iam';
import type {Session} from '../contracts';
const statement={effect:'Allow' as const,actions:['*'],resources:['*']};
const session={id:'human',username:'Admin',role:'root',principal_type:'user',policy_statements:[statement]} as Session;
const role={id:'role-1',name:'Agent tester',description:'',parent_id:null,policy:{statements:[statement]},daily_token_limit:5000,effective_daily_token_limit:5000,effective_statements:[statement],inheritance:[],builtin:false,updated_at:'2026-11-13'};
const principal={id:'principal-1',name:'CI runner',description:'Synthetic fixture',role_id:role.id,role_name:role.name,active:true,created_at:'2026-11-13',daily_token_limit:5000,used_today:123,scope:'agent_only'};
const metadata={id:'key-1',principal_id:principal.id,name:'Regression key',prefix:'tcg_api_fixture…',status:'active',created_at:'2026-11-13T00:00:00Z',expires_at:'2026-12-13T00:00:00Z',last_used_at:null,revoked_at:null};
const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
afterEach(()=>vi.unstubAllGlobals());
it('matches inherited policies with Deny precedence and keeps API credentials agent-only',()=>{
 const inherited={...session,policy_statements:[statement,{effect:'Deny' as const,actions:['agent:models:invoke'],resources:['model:blocked*']}]};
 expect(permits(inherited,'agent:models:invoke','model:blocked-1')).toBe(false);
 expect(permits(inherited,'agent:models:invoke','model:allowed')).toBe(true);
 expect(permits({...session,policy_statements:[]},'agent:models:list')).toBe(false);
 expect(permits({...session,policy_statements:undefined},'agent:models:list')).toBe(false);
 expect(permits({...session,principal_type:'api'},'iam:roles:write')).toBe(false);
 expect(permits({...session,principal_type:'api'},'agent:models:list')).toBe(true);
});
it('creates a one-time credential and revokes metadata without retaining the secret',async()=>{
 const user=userEvent.setup();let tokens:typeof metadata[]=[];
 const fetcher=vi.fn(async(path:string,options:RequestInit={})=>{
  if(path.endsWith('/roles'))return json([role]);
  if(path.endsWith('/principals'))return json([principal]);
  if(options.method==='POST'){tokens=[metadata];return json({credential:'tcg_api_synthetic_one_time',metadata});}
  if(options.method==='DELETE'){tokens=[{...metadata,status:'revoked'}];return json({revoked:true});}
  return json(tokens);
 });vi.stubGlobal('fetch',fetcher);
 render(<IAMAccess token="synthetic" mode="principals" session={session}/>);
 await user.click(await screen.findByRole('button',{name:'CI runner'}));
 expect(screen.getByText('123 / 5,000 tokens')).toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Create API token'}));
 let modal=screen.getByRole('dialog');
 await user.type(within(modal).getByLabelText('Token name'),'Regression key');
 expect(within(modal).getByLabelText('Lifetime (days)')).toHaveValue(30);
 await user.click(within(modal).getByRole('button',{name:'Create API token'}));
 expect(await screen.findByDisplayValue('tcg_api_synthetic_one_time')).toBeInTheDocument();
 expect(fetcher.mock.calls.some(([,options])=>options?.body===JSON.stringify({name:'Regression key',expires_in_days:30}))).toBe(true);
 await user.click(screen.getByRole('button',{name:'Done'}));
 expect(screen.queryByDisplayValue('tcg_api_synthetic_one_time')).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Revoke Regression key'}));
 modal=screen.getByRole('dialog');await user.click(within(modal).getByRole('button',{name:'Revoke token'}));
 await screen.findByText('API token revoked.');
 expect(screen.queryByRole('button',{name:'Revoke Regression key'})).not.toBeInTheDocument();
 expect(screen.queryByText('tcg_api_synthetic_one_time')).not.toBeInTheDocument();
});
it('inherits a selected parent quota and confirms unsaved exit from the Cloudscape editor',async()=>{
 const user=userEvent.setup();vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/catalog')?{actions:[]}: [role])));
 render(<IAMAccess token="synthetic" mode="roles" session={session}/>);
 await waitFor(()=>expect(screen.queryByText('Loading IAM roles')).not.toBeInTheDocument());
 await user.click(screen.getByRole('button',{name:'Create role'}));
 const modal=screen.getByRole('dialog');await user.type(within(modal).getByLabelText('Role name'),'Child');
 await user.click(within(modal).getByRole('button',{name:/No parent role/}));
 await user.click(screen.getByRole('option',{name:'Agent tester'}));
 expect(within(modal).getByText('Inherited allowance: 5,000 tokens per day.')).toBeInTheDocument();
 await user.click(within(modal).getByRole('button',{name:'Cancel'}));
 expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'Keep editing'}));
 expect(screen.getByDisplayValue('Child')).toBeInTheDocument();
});

it('evaluates resource-scoped capabilities with explicit Deny precedence',()=>{
 const models=[{id:'review-model',enabled:true},{id:'blocked-model',enabled:true}];
 const apiBase={...session,principal_type:'api' as const};

 const modelAllow={...apiBase,policy_statements:[{effect:'Allow' as const,actions:['agent:models:invoke'],resources:['model:review-model']}]};
 expect(evaluateAgentCapability(modelAllow,'agent:models:invoke',{models})).toMatchObject({
  status:'scoped',type:'success',label:'Resource-scoped',detail:'Allowed for review-model',
 });
 expect(evaluateAgentCapability(modelAllow,'agent:models:invoke',{models:[]})).toMatchObject({
  status:'scoped',type:'info',label:'Resource-scoped',detail:'Grants: model:review-model',
 });

 const partialDeny={...apiBase,policy_statements:[
  {effect:'Allow' as const,actions:['agent:models:invoke'],resources:['model:review-model','model:blocked-model']},
  {effect:'Deny' as const,actions:['agent:models:invoke'],resources:['model:blocked-model']},
 ]};
 const partial=evaluateAgentCapability(partialDeny,'agent:models:invoke',{models});
 expect(partial).toMatchObject({status:'scoped',type:'success',label:'Resource-scoped'});
 expect(partial.detail).toContain('Allowed for review-model');
 expect(partial.detail).toContain('excluded by policy: blocked-model');

 const exactDeny={...apiBase,policy_statements:[
  {effect:'Allow' as const,actions:['agent:models:invoke'],resources:['model:review-model']},
  {effect:'Deny' as const,actions:['agent:models:invoke'],resources:['model:review-model']},
 ]};
 expect(evaluateAgentCapability(exactDeny,'agent:models:invoke',{models})).toMatchObject({status:'denied',label:'Denied'});

 const wildcardThenModelDeny={...apiBase,policy_statements:[
  {effect:'Allow' as const,actions:['agent:*'],resources:['*']},
  {effect:'Deny' as const,actions:['agent:models:invoke'],resources:['model:*']},
 ]};
 expect(evaluateAgentCapability(wildcardThenModelDeny,'agent:models:invoke',{models})).toMatchObject({status:'denied',label:'Denied'});

 const execScoped={...apiBase,policy_statements:[{effect:'Allow' as const,actions:['agent:executions:read'],resources:['execution:exec-1']}]};
 expect(evaluateAgentCapability(execScoped,'agent:executions:read',{executionId:'exec-1'})).toMatchObject({status:'scoped',type:'success',label:'Resource-scoped'});
 expect(evaluateAgentCapability(execScoped,'agent:executions:read',{executionId:'exec-2'})).toMatchObject({status:'scoped',type:'warning',label:'Resource-scoped'});

 const convExcluded={...apiBase,policy_statements:[
  {effect:'Allow' as const,actions:['agent:conversations:write'],resources:['conversation:conv-*']},
  {effect:'Deny' as const,actions:['agent:conversations:write'],resources:['conversation:conv-locked']},
 ]};
 expect(evaluateAgentCapability(convExcluded,'agent:conversations:write',{conversationId:'conv-open'})).toMatchObject({status:'scoped',type:'success'});
 expect(evaluateAgentCapability(convExcluded,'agent:conversations:write',{conversationId:'conv-locked'})).toMatchObject({status:'scoped',type:'warning'});
});
