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
export const administrationActions=['admin:usage:read','admin:accounts:read','admin:models:read','admin:activity:read','admin:legality:read','iam:roles:read','iam:principals:read'];
export const canAdmin=(session:Session)=>session.principal_type!=='api'&&administrationActions.some(action=>permits(session,action));
export const roleLabel=(session:Pick<Session,'role'|'role_name'>)=>session.role_name||(session.role==='admin'?'Administrator':session.role==='user'?'User':session.role);

export interface AgentCapabilityContext {
  models?: { id: string; label?: string; enabled?: boolean }[];
  selectedModelId?: string;
  conversationId?: string;
  executionId?: string;
}

export interface AgentCapabilityStatus {
  status: 'allowed' | 'scoped' | 'denied';
  type: 'success' | 'info' | 'warning' | 'stopped';
  label: string;
  detail?: string;
}

const SCOPE_PROBE = '__iam_scope_probe__';
const RESOURCE_PREFIX_BY_ACTION: Record<string, string> = {
  'agent:models:invoke': 'model:',
  'agent:conversations:read': 'conversation:',
  'agent:conversations:write': 'conversation:',
  'agent:conversations:delete': 'conversation:',
  'agent:executions:read': 'execution:',
  'agent:executions:resume': 'execution:',
};

const summarizeList = (values: string[], limit = 3) =>
  values.length <= limit ? values.join(', ') : `${values.slice(0, limit).join(', ')} (+${values.length - limit} more)`;

const probeForPattern = (pattern: string) => (pattern.includes('*') ? pattern.replace(/\*/g, SCOPE_PROBE) : pattern);

export function evaluateAgentCapability(
  session: Session | undefined,
  action: string,
  context?: AgentCapabilityContext,
): AgentCapabilityStatus {
  if (!session) return { status: 'allowed', type: 'success', label: 'Allowed' };
  if (session.principal_type === 'api' && !action.startsWith('agent:')) {
    return { status: 'denied', type: 'stopped', label: 'Denied' };
  }
  const wildcardAllowed = permits(session, action, '*');
  if (!session.policy_statements) {
    return wildcardAllowed
      ? { status: 'allowed', type: 'success', label: 'Allowed' }
      : { status: 'denied', type: 'stopped', label: 'Denied' };
  }

  const prefix = RESOURCE_PREFIX_BY_ACTION[action];
  if (!prefix) {
    return wildcardAllowed
      ? { status: 'allowed', type: 'success', label: 'Allowed' }
      : { status: 'denied', type: 'stopped', label: 'Denied' };
  }

  const statements = session.policy_statements;
  const matchingAllows = statements.filter((s) => s.effect === 'Allow' && s.actions.some((p) => matches(action, p)));
  const matchingDenies = statements.filter((s) => s.effect === 'Deny' && s.actions.some((p) => matches(action, p)));
  const allowPatterns = [...new Set(matchingAllows.flatMap((s) => s.resources))];
  const survivingAllowPatterns = allowPatterns.filter((pat) => permits(session, action, probeForPattern(pat)));

  if (action === 'agent:models:invoke') {
    const activeModels = (context?.models || []).filter((m) => m.enabled !== false);
    const permittedModels = activeModels.filter((m) => permits(session, action, `model:${m.id}`));
    const deniedModels = activeModels.filter((m) => !permits(session, action, `model:${m.id}`));
    const probeModelAllowed = permits(session, action, `model:${SCOPE_PROBE}`);

    if (wildcardAllowed) {
      if (matchingDenies.length === 0) {
        return { status: 'allowed', type: 'success', label: 'Allowed' };
      }
      if (!probeModelAllowed && permittedModels.length === 0) {
        return { status: 'denied', type: 'stopped', label: 'Denied' };
      }
      if (activeModels.length > 0) {
        if (permittedModels.length > 0) {
          const permittedIds = summarizeList(permittedModels.map((m) => m.id));
          const deniedSuffix = deniedModels.length
            ? ` (excluded by policy: ${summarizeList(deniedModels.map((m) => m.id))})`
            : '';
          return {
            status: 'scoped',
            type: 'success',
            label: 'Resource-scoped',
            detail: `Allowed for ${permittedIds}${deniedSuffix}`,
          };
        }
        return {
          status: 'scoped',
          type: 'warning',
          label: 'Resource-scoped',
          detail: `No listed models permitted (excluded by policy: ${summarizeList(deniedModels.map((m) => m.id))})`,
        };
      }
      return {
        status: 'scoped',
        type: 'info',
        label: 'Resource-scoped',
        detail: 'Wildcard allow with explicit exclusions',
      };
    }

    if (activeModels.length > 0) {
      if (permittedModels.length > 0) {
        const permittedIds = summarizeList(permittedModels.map((m) => m.id));
        const excludedByExplicitDeny = deniedModels.filter((m) =>
          matchingDenies.some((s) => s.resources.some((p) => matches(`model:${m.id}`, p))),
        );
        const excludedNote = excludedByExplicitDeny.length
          ? ` (excluded by policy: ${summarizeList(excludedByExplicitDeny.map((m) => m.id))})`
          : '';
        return {
          status: 'scoped',
          type: 'success',
          label: 'Resource-scoped',
          detail: `Allowed for ${permittedIds}${excludedNote}`,
        };
      }
      if (survivingAllowPatterns.length === 0) {
        return { status: 'denied', type: 'stopped', label: 'Denied' };
      }
      const excludedByExplicitDeny = deniedModels.filter((m) =>
        matchingDenies.some((s) => s.resources.some((p) => matches(`model:${m.id}`, p))),
      );
      return {
        status: 'scoped',
        type: 'warning',
        label: 'Resource-scoped',
        detail: excludedByExplicitDeny.length
          ? `No listed models permitted (excluded by policy: ${summarizeList(excludedByExplicitDeny.map((m) => m.id))})`
          : `Grants: ${summarizeList(survivingAllowPatterns)} (not listed)`,
      };
    }

    if (survivingAllowPatterns.length > 0) {
      return {
        status: 'scoped',
        type: 'info',
        label: 'Resource-scoped',
        detail: `Grants: ${summarizeList(survivingAllowPatterns)}`,
      };
    }
    return { status: 'denied', type: 'stopped', label: 'Denied' };
  }

  const activeConcreteResource =
    action.startsWith('agent:executions:')
      ? context?.executionId
        ? `execution:${context.executionId}`
        : undefined
      : context?.conversationId
        ? `conversation:${context.conversationId}`
        : undefined;
  const probePrefixedAllowed = permits(session, action, `${prefix}${SCOPE_PROBE}`);

  if (wildcardAllowed) {
    if (matchingDenies.length === 0) {
      return { status: 'allowed', type: 'success', label: 'Allowed' };
    }
    if (!probePrefixedAllowed && action !== 'agent:conversations:read') {
      return { status: 'denied', type: 'stopped', label: 'Denied' };
    }
    if (activeConcreteResource) {
      const allowedHere = permits(session, action, activeConcreteResource);
      return {
        status: 'scoped',
        type: allowedHere ? 'success' : 'warning',
        label: 'Resource-scoped',
        detail: allowedHere
          ? `Allowed for ${activeConcreteResource} (with policy exclusions)`
          : `Excluded for ${activeConcreteResource} by policy`,
      };
    }
    return {
      status: 'scoped',
      type: 'info',
      label: 'Resource-scoped',
      detail: 'Wildcard allow with explicit exclusions',
    };
  }

  if (activeConcreteResource && permits(session, action, activeConcreteResource)) {
    return {
      status: 'scoped',
      type: 'success',
      label: 'Resource-scoped',
      detail: `Allowed for ${activeConcreteResource}`,
    };
  }

  if (survivingAllowPatterns.length > 0) {
    return {
      status: 'scoped',
      type: activeConcreteResource ? 'warning' : 'info',
      label: 'Resource-scoped',
      detail: activeConcreteResource
        ? `Grants: ${summarizeList(survivingAllowPatterns)} (not matching ${activeConcreteResource})`
        : `Grants: ${summarizeList(survivingAllowPatterns)}`,
    };
  }

  return { status: 'denied', type: 'stopped', label: 'Denied' };
}
