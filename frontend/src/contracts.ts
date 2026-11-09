export interface ImageContext {name:string;media_type:string;data_url:string}
export interface Source { url: string; title: string; retrieved_at: string; excerpt?: string }
export interface Card { card_id: string; name: string; quantity: number; set_name: string; number: string; condition: string; language: string; printing: string; image_url?: string|null }
export interface Offer { id: string; name: string; supplier: string; price: string; currency: string; quantity: number|null; availability: string; price_kind: string; number?: string|null; printing?: string|null; condition?: string|null; language?: string|null; source: Source }
export interface Legality { status: 'verified'|'unverified'; issues: string[]; sources: Source[] }
export interface Allocation { offer_id: string; supplier: string; quantity: number; unit_price: string; line_total: string; url: string }
export interface BudgetLine { card_id: string; name: string; requested: number; covered: number; allocations: Allocation[]; set_name?: string; number?: string; condition?: string; language?: string; printing?: string }
export interface Budget { supplier: string; currency: string; complete: boolean; product_subtotal: string; known_shipping: string|null; shipping_confirmed: boolean; confirmed_total: string|null; lines: BudgetLine[] }
export interface Missing { card_id: string; name: string; quantity: number; set_name?: string; number?: string; condition?: string; language?: string; printing?: string }
export interface Question { kind: 'clarification'|'missing_cards'; question: string; missing?: Missing[]; guidance?: string; actions: string[] }
export interface Model { id: string; label: string; provider: string; api_id: string; enabled: boolean; verified_at?: string|null }
export interface Session { id: string; username: string; role: string; totp_enrolled: boolean; webauthn_enrolled: boolean; webauthn_credentials_count: number }
export interface Result { plan: { cards: Card[]; format: string; sources: Source[]; explanation: string }; legality: Legality; offers: Offer[]; budgets: Budget[]; missing: Missing[]; supplier_errors: {supplier:string;message:string}[]; recommendation: string }
export type AgentEvent =
  | {type:'execution';data:{id:string;conversation_id:string}}
  | {type:'thinking';data:{id:string;status:'loading'|'complete'|'error';source:'provider_summary'|'approach_summary';summary:string}}
  | {type:'tool';data:{id:string;name:string;status:'loading'|'complete'|'error';input:Record<string,string>;sources:{url:string;title:string}[];duration_ms?:number}}
  | {type:'progress';data:{step:string;message:string;limitations?:{supplier:string;message:string}[]}}
  | {type:'cards';data:{cards:Card[];sources:Source[];legality:Legality}}
  | {type:'question';data:Question}
  | {type:'result';data:Result}
  | {type:'error';data:{message:string}}
  | {type:'done';data:{status:string}};
export type Decision = {action:'clarify'|'substitute'|'keep_missing'|'cancel';text?:string;approved?:boolean};
export interface Conversation { id:string;title:string }
