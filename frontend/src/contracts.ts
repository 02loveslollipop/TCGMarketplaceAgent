export interface ImageContext {name:string;media_type:string;data_url:string}
export interface Source { url: string; title: string; retrieved_at: string; excerpt?: string }
export interface Card { card_id: string; name: string; quantity: number; set_name: string; number: string; condition: string; language: string; printing: string; image_url?: string|null }
export interface Offer { id: string; name: string; supplier: string; price: string; currency: string; quantity: number|null; availability: string; price_kind: string; number?: string|null; printing?: string|null; condition?: string|null; language?: string|null; source: Source; converted_price?:string }
export interface Legality { applicable?:boolean; status: 'verified'|'unverified'; issues: string[]; sources: Source[] }
export interface Allocation { offer_id: string; supplier: string; quantity: number; unit_price: string; line_total: string; url: string; converted_unit_price?:string;converted_line_total?:string }
export interface BudgetLine { card_id: string; name: string; requested: number; covered: number; allocations: Allocation[]; set_name?: string; number?: string; condition?: string; language?: string; printing?: string }
export interface Budget { supplier: string; currency: string; complete: boolean; product_subtotal: string; known_shipping: string|null; shipping_confirmed: boolean; confirmed_total: string|null; lines: BudgetLine[]; converted?:ConvertedTotals }
export interface ConvertedTotals {product_subtotal:string;known_shipping:string|null;confirmed_total:string|null}
export interface CurrencyConversion {status:'available'|'unavailable';target_currency:string;rates?:Record<string,string>;as_of?:string;retrieved_at?:string;source?:{url:string;title:string};notice?:string;message?:string}
export interface ReferenceEstimate {supplier:string;currency:string;product_subtotal:string;priced_cards:number;requested_cards:number;price_coverage_complete:boolean;converted?:ConvertedTotals;lines:{card_id:string;name:string;set_name?:string;number?:string;condition?:string;language?:string;printing?:string;quantity:number;unit_price:string;line_total:string;converted_unit_price?:string;converted_line_total?:string;source:Source}[]}
export interface Missing { card_id: string; name: string; quantity: number; set_name?: string; number?: string; condition?: string; language?: string; printing?: string }
export interface Question { kind: 'clarification'|'missing_cards'|'deck_approval'; question: string; options?: string[]; missing?: Missing[]; guidance?: string; actions: string[];card_count?:number;unique_cards?:number;format?:string;ruleset?:string;location?:string;target_currency?:string|null }
export interface Model { id: string; label: string; provider: string; api_id: string; enabled: boolean; verified_at?: string|null }
export interface Session { principal_type?:'user'|'api';role_name?:string;iam_role_id?:string|null;key_reference?:string|null;policy_statements?:import('./iam').Statement[];id: string; username: string; role: string; totp_enrolled: boolean; webauthn_enrolled: boolean; webauthn_credentials_count: number }
export interface DailyUsage { daily_token_limit: number; total_tokens: number; remaining_tokens: number; unverified_usage: boolean; in_progress: boolean }
export interface ExecutionStatusSnapshot { id: string; conversation_id: string; status: string; checkpoint?: Record<string, unknown>; events?: { type: string; data: unknown }[] }
export interface RetrievalDiagnostic {supplier:string;card_id:string;phase:string;layer:string;outcome:string;message:string;http_status:number|null;retrieved_at:string}
export interface CollectionSummary {status:string;subject:string;budget_amount:string;currency:string;product_subtotal:string|null;remaining_budget:string|null;selected_printings:number;researched_candidates:number;preferred_selected:number;limitations:string[];exchange?:CurrencyConversion;lines:{card_id:string;name:string;set_name?:string;number?:string;condition?:string;language?:string;printing?:string;supplier:string;original_currency:string;original_unit_price?:string;original_line_total:string;converted_unit_price?:string;converted_line_total:string;source:Source;rarity?:string}[];excluded_candidates:{card_id:string;name:string;reason:string}[]}
export interface Result {collection_summary?:CollectionSummary; plan: { purpose?:string;cards: Card[]; format: string; sources: Source[]; explanation: string }; legality: Legality; offers: Offer[]; budgets: Budget[]; missing: Missing[]; supplier_errors: {supplier:string;message:string}[]; recommendation: string;stock_shortages?:Missing[];availability_unverified?:Missing[];retrieval_diagnostics?:RetrievalDiagnostic[];reference_estimates?:ReferenceEstimate[];currency_conversion?:CurrencyConversion;preferences?:UserPreferences }
export type AgentEvent =
  | {type:'execution';data:{id:string;conversation_id:string}}
  | {type:'thinking';data:{id:string;status:'loading'|'complete'|'error';source:'provider_summary'|'approach_summary';summary:string}}
  | {type:'tool';data:{id:string;name:string;status:'loading'|'complete'|'error';input:Record<string,string>;sources:{url:string;title:string}[];duration_ms?:number;diagnostic?:Pick<RetrievalDiagnostic,'layer'|'outcome'|'message'|'http_status'>}}
  | {type:'progress';data:{step:string;message:string;limitations?:{supplier:string;message:string}[]}}
  | {type:'cards';data:{cards:Card[];sources:Source[];legality:Legality}}
  | {type:'question';data:Question}
  | {type:'result';data:Result}
  | {type:'error';data:{message:string}}
  | {type:'done';data:{status:string}};
export type Decision = {action:'clarify'|'approve_deck'|'revise_deck'|'substitute'|'keep_missing'|'cancel';text?:string;selected_option?:string;approved?:boolean};
export interface Conversation { id:string;title:string }

export interface UserPreferences {
  ruleset: 'auto' | 'international' | 'japan';
  format: 'auto' | 'standard' | 'expanded';
  location?:string;
  target_currency?:string|null;
  updated_at?: string | null;
}

export interface LegalityStatus {
  status: string;
  last_refreshed_at: string | null;
  next_refresh_at: string | null;
  triggered_by: string | null;
  international_standard_marks: string[];
  japan_standard_marks: string[];
  sets_count: number;
  banned_count: number;
  sources: string[];
  error: string | null;
}

export interface AdminExecutionSummary {
  usage?:ExecutionUsage;
  id: string;
  conversation_id: string;
  conversation_title: string;
  user_id: string;
  model_id: string;
  status: string;
  created_at: string;
}

export interface AdminThreadExecution {
  id: string;
  model_id: string;
  status: string;
  created_at: string;
}

export interface AdminExecutionDetail {
  usage?:ExecutionUsage;
  id: string;
  conversation_id: string;
  conversation_title: string;
  user_id: string;
  model_id: string;
  status: string;
  created_at: string;
  checkpoint: Record<string, unknown>;
  reasoning_summary: string;
  events: { id: string; kind: string; payload: any; created_at: string }[];
  logs?: { id: string; action: string; details: any; created_at: string }[];
  messages?: { id: string; role: string; content: any; created_at: string }[];
  thread_executions?: AdminThreadExecution[];
}


export interface UsageBucket {id:string;name:string;input_tokens:number;output_tokens:number;total_tokens:number;estimated_cost_usd:string|null;priced_tokens:number;unpriced_tokens:number;verified_calls:number;rejected_calls:number;unverified_calls:number}
export interface PrincipalConsumption extends UsageBucket {active?:boolean;principal_type?:'user'|'api'|'unknown';today_tokens?:number;in_progress?:boolean;unverified_usage?:boolean;current_role_name?:string|null;daily_token_limit?:number|null;quota_known?:boolean}
export interface ConsumptionReport {start_date:string;end_date:string;timezone:string;today:string;summary:UsageBucket;daily:UsageBucket[];principals:PrincipalConsumption[];roles:UsageBucket[];models:UsageBucket[];active_calls:number;detail_truncated:boolean;notice:string;generated_at:string;metadata_warnings?:string[]}
export interface ModelPricing {model_id:string;label:string;provider:string;api_id:string;pricing:{currency:string;input_per_million:string;output_per_million:string;source_url?:string|null;note?:string;origin?:string;updated_at?:string;checked_at?:string}|null}
export interface ExecutionUsage extends UsageBucket {recorded:boolean;model_duration_ms:number|null}
