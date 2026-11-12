import type {Session} from './contracts';
export interface Statement {effect:'Allow'|'Deny';actions:string[];resources:string[]}
export interface IAMRole {id:string;name:string;description:string;parent_id:string|null;policy:{statements:Statement[]};daily_token_limit:number|null;effective_daily_token_limit:number;effective_statements:Statement[];inheritance:{id:string;name:string}[];builtin:boolean;builtin_key?:'user'|'admin'|null;updated_at:string}
export interface APIPrincipal {id:string;name:string;description:string;role_id:string;role_name:string;active:boolean;created_at:string;daily_token_limit:number;used_today:number;scope:'agent_only'}
export interface APIToken {id:string;principal_id:string;name:string;prefix:string;status:'active'|'expired'|'revoked';created_at:string;expires_at:string;last_used_at:string|null;revoked_at:string|null}
export interface IAMCatalog {actions:{value:string;id:string;label:string}[];quota_timezone:string;api_scope:string}
const matches=(value:string,pattern:string)=>new RegExp('^'+pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(value);
export function permits(session:Session|undefined,action:string,resource='*'):boolean {
  if(!session)return true; // Standalone component callers retain server authorization.
  if(session.principal_type==='api'&&!action.startsWith('agent:'))return false;
  if(!session.policy_statements){
    if(session.principal_type==='api'||!['user','admin'].includes(session.role))return false;
    return session.role==='admin'||action.startsWith('agent:')||action==='account:self:manage';
  }
  let allowed=false;
  for(const statement of session.policy_statements){
    if(statement.actions.some(pattern=>matches(action,pattern))&&statement.resources.some(pattern=>matches(resource,pattern))){
      if(statement.effect==='Deny')return false;
      if(statement.effect==='Allow')allowed=true;
    }
  }
  return allowed;
}
export const administrationActions=['admin:accounts:read','admin:models:read','admin:activity:read','admin:legality:read','iam:roles:read','iam:principals:read'];
export const canAdmin=(session:Session)=>session.principal_type!=='api'&&administrationActions.some(action=>permits(session,action));
export const roleLabel=(session:Pick<Session,'role'|'role_name'>)=>session.role_name||(session.role==='admin'?'Administrator':session.role==='user'?'User':session.role);
