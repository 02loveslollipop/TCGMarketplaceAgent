import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {DecisionPanel} from '../DecisionPanel';
import {BudgetResults} from '../Results';
import {Preferences} from '../Preferences';
import {Chat} from '../Chat';
import {ArtifactPreview} from '../ChatArtifacts';
import type {Question,Result} from '../contracts';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
afterEach(()=>vi.unstubAllGlobals());
const question:Question={kind:'deck_approval',question:'Review the deck, then approve it to compare supplier prices.',actions:['approve_deck','revise_deck','cancel'],card_count:60,unique_cards:18,format:'expanded',ruleset:'international',location:'Tokyo, Japan',target_currency:'JPY'};

it('offers explicit deck approval, changes, and cancellation in chat',async()=>{
  const user=userEvent.setup(),decide=vi.fn();
  render(<DecisionPanel question={question} onDecision={decide} busy={false}/>);
  expect(screen.getByText('60 cards · 18 printings · expanded')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Request changes'})).toBeEnabled();
  await user.click(screen.getByRole('button',{name:'Approve and price this deck'}));
  expect(decide).toHaveBeenLastCalledWith({action:'approve_deck',approved:true});
  await user.click(screen.getByRole('button',{name:'Request changes'}));
  await user.type(screen.getByRole('textbox',{name:'Changes to this deck'}),'Replace the attacker');
  await user.click(screen.getByRole('button',{name:'Submit deck changes'}));
  expect(decide).toHaveBeenLastCalledWith({action:'revise_deck',text:'Replace the attacker'});
  await user.click(screen.getByRole('button',{name:'Back to approval'}));
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  expect(decide).toHaveBeenLastCalledWith({action:'cancel'});
});

it('keeps approval controls disabled while a decision is being submitted',()=>{
  render(<DecisionPanel question={question} onDecision={vi.fn()} busy/>);
  expect(screen.getByRole('button',{name:'Approve and price this deck'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Request changes'})).toBeDisabled();
});

const source={url:'https://example.com/guide',title:'Synthetic guide',retrieved_at:'2026-11-12T00:00:00Z'};
const result:Result={
  plan:{format:'expanded',cards:[],sources:[source],explanation:'Fixture only'},
  legality:{status:'unverified',issues:[],sources:[]},offers:[],budgets:[],missing:[],supplier_errors:[],recommendation:'Estimated buying costs for this deck.',
  reference_estimates:[{supplier:'TCGplayer',currency:'USD',product_subtotal:'75.00',priced_cards:60,requested_cards:60,price_coverage_complete:true,converted:{product_subtotal:'11250',known_shipping:null,confirmed_total:null},lines:[{card_id:'card-1',name:'Test',quantity:60,unit_price:'1.25',line_total:'75.00',converted_unit_price:'188',converted_line_total:'11250',source}]}],
  currency_conversion:{status:'available',target_currency:'JPY',rates:{USD:'150'},as_of:'2026-11-12T00:00:00Z',source:{url:'https://www.exchangerate-api.com',title:'Rates By Exchange Rate API'},notice:'Indicative conversion only. Unknown shipping is excluded.'},
};
it('defaults to converted deck costs with original prices, dated rates, and attribution',async()=>{
  const user=userEvent.setup();render(<BudgetResults result={result}/>);
  expect(screen.getByRole('heading',{name:'Estimated deck cost'})).toBeInTheDocument();
  expect(screen.getAllByText('11250 JPY')[0]).toBeVisible();
  expect(screen.getAllByText('Original: 75.00 USD')[0]).toBeVisible();
  expect(screen.getByText('150 JPY')).toBeVisible();
  expect(screen.getByText('1 USD')).toBeVisible();
  expect(screen.getByRole('link',{name:'Rates By Exchange Rate API'})).toHaveAttribute('href','https://www.exchangerate-api.com');
  expect(screen.getByText(/Purchase totals are not confirmed/)).toBeVisible();
  expect(screen.getByText('60 of 60 cards')).toBeVisible();
  await user.click(screen.getByRole('button',{name:'Original currencies'}));
  expect(screen.getAllByText('75.00 USD')[0]).toBeVisible();
  expect(screen.getAllByText('Estimated equivalent: 11250 JPY')[0]).toBeVisible();
});

it('preserves original cost display if currency conversion fails',()=>{
  render(<BudgetResults result={{...result,currency_conversion:{status:'unavailable',target_currency:'JPY',message:'Original supplier prices are preserved.'}}}/>);
  expect(screen.getByText('Currency conversion unavailable')).toBeVisible();
  expect(screen.getAllByText('75.00 USD')[0]).toBeVisible();
  expect(screen.queryByText('11250 JPY')).not.toBeInTheDocument();
});

it('shows rate-provider attribution with converted costs directly in the chat artifact',()=>{
  render(<ArtifactPreview artifact={{id:'budget',kind:'budget',result}} onOpen={vi.fn()}/>);
  expect(screen.getByText('11250 JPY')).toBeVisible();
  expect(screen.getByRole('link',{name:'Rates By Exchange Rate API'})).toHaveAttribute('href','https://www.exchangerate-api.com');
});

it('loads and saves location as guidance and a target currency without changing an unsaved draft on session renewal',async()=>{
  const fetcher=vi.fn(async(path:string,options?:RequestInit)=>{
    if(path.endsWith('/currencies'))return json(['USD','EUR','JPY','COP']);
    return json(options?.method==='PUT'?JSON.parse(String(options.body)):{ruleset:'auto',format:'expanded',location:'',target_currency:null});
  });
  vi.stubGlobal('fetch',fetcher);
  const user=userEvent.setup(),view=render(<Preferences token="first-session"/>);
  const location=await screen.findByRole('searchbox',{name:'Shopping location'});
  await user.type(location,'Tokyo, Japan');
  view.rerender(<Preferences token="renewed-session"/>);
  expect(location).toHaveValue('Tokyo, Japan');
  await user.click(screen.getByRole('button',{name:/^Target currency /}));
  await user.click(screen.getByRole('option',{name:/JPY/}));
  await user.click(screen.getByRole('button',{name:'Save preferences'}));
  await screen.findByText('Preferences saved. New requests will use these settings.');
  const request=fetcher.mock.calls.find(([,options])=>options?.method==='PUT')!;
  expect(JSON.parse(String(request[1]?.body))).toEqual({ruleset:'auto',format:'expanded',location:'Tokyo, Japan',target_currency:'JPY'});
  expect(screen.getByText(/does not exclude other suppliers/)).toBeInTheDocument();
});

it('does not save fallback defaults after a failed preferences load',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/currencies')?json(['USD']):json({error:{message:'Load failed'}},503)));
  render(<Preferences token="session"/>);
  await screen.findByText('Load failed');
  expect(screen.getByRole('button',{name:'Save preferences'})).toBeDisabled();
});

it('exposes a settings action in the chat navigation',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/models')?[{id:'model',label:'Test model',provider:'openai',api_id:'fixture',enabled:true}]:path.endsWith('/usage')?{daily_token_limit:50000,total_tokens:0,remaining_tokens:50000}:[])));
  render(<Chat token="session"/>);
  await screen.findByText('Test model');
  expect(within(screen.getByTestId('chat-prompt-input')).getByRole('link',{name:'Agent preferences'})).toHaveAttribute('href','#preferences');
});
