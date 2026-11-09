import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Chat} from '../Chat';
import {DecisionPanel} from '../DecisionPanel';
import {Login} from '../Login';
import {stream} from '../client';
import {WebAuthnSettings} from '../WebAuthn';
import {BudgetResults} from '../Results';
import type {Result} from '../contracts';
import {startAuthentication,startRegistration} from '@simplewebauthn/browser';

vi.mock('@simplewebauthn/browser',()=>({startAuthentication:vi.fn(),startRegistration:vi.fn(),WebAuthnAbortService:{cancelCeremony:vi.fn()}}));

const source={url:'https://example.com/card',title:'Synthetic card source',retrieved_at:'2026-11-06T00:00:00Z'};
const card={card_id:'test-1',name:'Test ex',quantity:4,set_name:'Test',number:'1',condition:'NM',language:'English',printing:'Holofoil',image_url:'https://example.com/card.png'};
const legality={status:'unverified' as const,issues:['Synthetic legality evidence only'],sources:[source]};
function json(value:unknown){return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});}
afterEach(()=>vi.unstubAllGlobals());

describe('Cloudscape chat',()=>{
  it('streams actual fixed card components with card codes, quantities and source dates',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
      if(path.endsWith('/models'))return json([{id:'test',label:'GPT test',provider:'openai',api_id:'test',enabled:true}]);
      if(path.endsWith('/conversations'))return json([]);
      const content=`event: execution\ndata: ${JSON.stringify({id:'execution-1',conversation_id:'conversation-1'})}\n\nevent: progress\ndata: ${JSON.stringify({step:'resolve',message:'Resolved printings'})}\n\nevent: cards\ndata: ${JSON.stringify({cards:[card],sources:[source],legality})}\n\nevent: done\ndata: {"status":"complete"}\n\n`;
      return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(content));controller.close();}}));
    }));
    const user=userEvent.setup();render(<Chat token="private-token"/>);
    await screen.findByText('GPT test');
    await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Find Test ex');
    await user.click(screen.getByRole('button',{name:'Send request'}));
    expect(await screen.findByText(/I resolved these card printings/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button',{name:'Review deck list'}));
    expect(await screen.findByRole('img',{name:'Test ex card'})).toHaveAttribute('src',card.image_url);
    await user.click(screen.getByRole('button',{name:'Table'}));
    expect(screen.getByTestId('deck-table')).toHaveTextContent('Test 1');
    expect(screen.getByTestId('deck-table')).toHaveTextContent('4');
    expect(within(screen.getByRole('dialog',{name:'Deck preview'})).getByText('Format legality: unverified')).toBeInTheDocument();
    const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/executions'))!;
    expect((call[1]?.headers as Record<string,string>).Authorization).toBe('Bearer private-token');
    expect(String(call[0])).not.toContain('private-token');
  });

  it('requires explicit missing-card consent with keyboard accessible actions',async()=>{
    const onDecision=vi.fn(),user=userEvent.setup();
    render(<DecisionPanel question={{kind:'missing_cards',question:'Choose how to proceed',guidance:'A support card may be an alternative.',missing:[{card_id:'test',name:'Missing ex',quantity:2}],actions:['substitute','keep_missing','cancel']}} busy={false} onDecision={onDecision}/>);
    const button=screen.getByRole('button',{name:'Keep listed cards missing'});
    expect(button).toBeDisabled();
    const checkbox=screen.getByRole('checkbox');checkbox.focus();await user.keyboard(' ');
    expect(button).toBeEnabled();button.focus();await user.keyboard('{Enter}');
    expect(onDecision).toHaveBeenCalledWith({action:'keep_missing',approved:true});
    expect(screen.getByText('2 × Missing ex')).toBeInTheDocument();
  });

  it('shows the specific missing variant before asking for consent',()=>{
    render(<DecisionPanel question={{kind:'missing_cards',question:'Choose how to proceed',missing:[{card_id:'test',name:'Missing ex',quantity:1,set_name:'Example',number:'12',condition:'LP',language:'English',printing:'Holo'}],actions:['keep_missing']}} busy={false} onDecision={vi.fn()}/>);
    expect(screen.getByText('Example · #12 · LP · English · Holo')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Keep listed cards missing'})).toBeDisabled();
  });

  it('distinguishes shared-card variants in final budgets and missing quotations',async()=>{
    const nm={card_id:'test-1',name:'Test ex',set_name:'Test',number:'1',condition:'NM',language:'English',printing:'Holofoil'};
    const lp={...nm,condition:'LP'};
    const result:Result={plan:{cards:[card,{...card,condition:'LP'}],format:'standard',sources:[],explanation:''},legality,offers:[],supplier_errors:[],recommendation:'',
      budgets:[{supplier:'combined',currency:'USD',complete:false,product_subtotal:'1.00',known_shipping:null,shipping_confirmed:false,confirmed_total:null,
        lines:[{...nm,requested:1,covered:1,allocations:[{offer_id:'one',supplier:'TCGplayer',quantity:1,unit_price:'1.00',line_total:'1.00',url:'https://example.com/listing'}]},
               {...lp,requested:1,covered:0,allocations:[]}]}],missing:[{...lp,quantity:1}]};
    render(<BudgetResults result={result}/>);
    const budget=screen.getByTestId('budget-section');
    const rows=within(budget).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Test · #1 · NM · English · Holofoil');
    expect(rows[2]).toHaveTextContent('Test · #1 · LP · English · Holofoil');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href','https://example.com/listing');
    expect(screen.getByText('1 × Test ex · Test · #1 · LP · English · Holofoil')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab',{name:'Deck'}));
    expect(screen.getAllByRole('heading',{name:'Test ex'})).toHaveLength(2);
  });

  it('renders legacy budget and missing entries without variant fields',()=>{
    const result:Result={plan:{cards:[],format:'standard',sources:[],explanation:''},legality,offers:[],supplier_errors:[],recommendation:'',
      budgets:[{supplier:'combined',currency:'USD',complete:false,product_subtotal:'0',known_shipping:null,shipping_confirmed:false,confirmed_total:null,lines:[{card_id:'legacy',name:'Legacy card',requested:1,covered:0,allocations:[]}]}],
      missing:[{card_id:'legacy',name:'Legacy card',quantity:1}]};
    render(<BudgetResults result={result}/>);
    expect(within(screen.getByTestId('budget-section')).getByText('Variant details unavailable')).toBeInTheDocument();
    expect(screen.getByText('1 × Legacy card · Variant details unavailable')).toBeInTheDocument();
  });

  it('parses split SSE frames and never displays executable model markup',async()=>{
    const text='event: progress\ndata: {"step":"test","message":"<script>alert(1)</script>"}\n\n';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){for(const chunk of [text.slice(0,18),text.slice(18)])controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}))));
    const receive=vi.fn();await stream('/api/chat/executions','token',{},receive,new AbortController().signal);
    expect(receive).toHaveBeenCalledWith({type:'progress',data:{step:'test',message:'<script>alert(1)</script>'}});
    render(<DecisionPanel question={{kind:'clarification',question:'<script>alert(1)</script>',actions:['clarify']}} busy={false} onDecision={()=>{}}/>);
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('keeps a second-factor challenge separate from a full login session',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>json({requires_2fa:true,challenge_token:'challenge-only'})));
    const onLogin=vi.fn(),user=userEvent.setup();render(<Login onLogin={onLogin}/>);
    await user.type(screen.getByLabelText('Username'),'one');await user.type(screen.getByLabelText('Password'),'long-password');
    await user.click(screen.getByRole('button',{name:'Sign in'}));
    expect(await screen.findByLabelText('Authenticator code')).toBeInTheDocument();expect(onLogin).not.toHaveBeenCalled();
  });

  it('enrolls a named authenticator only after server verification',async()=>{
    vi.mocked(startRegistration).mockResolvedValue({id:'credential'} as never);
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/credentials')?[]:path.endsWith('/options')?{challenge_id:'ceremony-1',options:{challenge:'challenge'}}:{enrolled:true,sign_in_again:true})));
    const user=userEvent.setup(),changed=vi.fn();render(<WebAuthnSettings token="access-token" onChange={changed}/>);
    await user.click(screen.getByRole('button',{name:'Passkeys and security keys'}));
    await user.click(screen.getByRole('button',{name:'Add authenticator'}));
    await user.type(screen.getByLabelText('Authenticator name'),'Physical key');
    await user.click(screen.getByRole('button',{name:'Add passkey or security key'}));
    await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
    const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/registration/verify'))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({challenge_id:'ceremony-1',credential:{id:'credential'}});
  });

  it('cancels an unsuccessful ceremony on the server and permits retry',async()=>{
    vi.mocked(startRegistration).mockRejectedValue(new DOMException('Cancelled','NotAllowedError'));
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/credentials')?[]:path.endsWith('/options')?{challenge_id:'cancel-me',options:{challenge:'challenge'}}:{cancelled:true})));
    const user=userEvent.setup(),changed=vi.fn();render(<WebAuthnSettings token="access-token" onChange={changed}/>);
    await user.click(screen.getByRole('button',{name:'Passkeys and security keys'}));
    await user.click(screen.getByRole('button',{name:'Add authenticator'}));
    await user.type(screen.getByLabelText('Authenticator name'),'Phone');
    await user.click(screen.getByRole('button',{name:'Add passkey or security key'}));
    expect(await screen.findByText('Authenticator operation was cancelled or timed out. You can try again.')).toBeInTheDocument();
    await waitFor(()=>expect(screen.getByRole('button',{name:'Add passkey or security key'})).toBeEnabled());
    expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).endsWith('/cancel-me/cancel'))).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it('offers WebAuthn and TOTP alternatives but accepts only the verified access session',async()=>{
    vi.mocked(startAuthentication).mockResolvedValue({id:'credential'} as never);
    const session={id:'one',username:'one',role:'user',totp_enrolled:true,webauthn_enrolled:true,webauthn_credentials_count:1};
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>json(path.endsWith('/token')?{requires_2fa:true,challenge_token:'password-proof',methods:['webauthn','totp']}:path.endsWith('/options')?{challenge_id:'auth-ceremony',options:{challenge:'challenge'}}:path.endsWith('/verify')?{access_token:'verified-token',token_type:'bearer',expires_in:900}:session)));
    const onLogin=vi.fn(),user=userEvent.setup();render(<Login onLogin={onLogin}/>);
    await user.type(screen.getByLabelText('Username'),'one');await user.type(screen.getByLabelText('Password'),'long-password');await user.click(screen.getByRole('button',{name:'Sign in'}));
    await screen.findByLabelText('Authenticator code');expect(onLogin).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio',{name:'Passkey or security key'}));
    await user.click(screen.getByRole('button',{name:'Use passkey or security key'}));
    await waitFor(()=>expect(onLogin).toHaveBeenCalledWith('verified-token',session));
    const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/authentication/verify'))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({challenge_token:'password-proof',challenge_id:'auth-ceremony',credential:{id:'credential'}});
  });

  it('honors cancellation while server options are still loading',async()=>{
    vi.mocked(startRegistration).mockClear();
    let resolveOptions!:(response:Response)=>void;
    const pending=new Promise<Response>(resolve=>{resolveOptions=resolve;});
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/options')?pending:json(path.endsWith('/credentials')?[]:{cancelled:true})));
    const user=userEvent.setup();render(<WebAuthnSettings token="access-token" onChange={()=>{}}/>);
    await user.click(screen.getByRole('button',{name:'Passkeys and security keys'}));await user.click(screen.getByRole('button',{name:'Add authenticator'}));await user.type(screen.getByLabelText('Authenticator name'),'Phone');
    await user.click(screen.getByRole('button',{name:'Add passkey or security key'}));await user.click(screen.getByRole('button',{name:'Cancel authenticator'}));
    resolveOptions(json({challenge_id:'cancel-before-prompt',options:{challenge:'challenge'}}));
    await screen.findByText('Authenticator operation was cancelled or timed out. You can try again.');
    expect(startRegistration).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(call=>String(call[0]).endsWith('/cancel-before-prompt/cancel'))).toBe(true);
  });
});

it('announces model changes in place and uses the selected model for the next request',async()=>{
  const models=[{id:'openai-test',label:'GPT test',provider:'openai',api_id:'test',enabled:true},{id:'mistral-test',label:'Mistral test',provider:'mistral',api_id:'test',enabled:true}];
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
    if(path.endsWith('/models'))return json(models);
    if(path.endsWith('/conversations'))return json([]);
    return new Response('event: done\ndata: {"status":"complete"}\n\n');
  }));
  const user=userEvent.setup();render(<Chat token="private-token"/>);
  await screen.findByText('GPT test');
  const select=within(screen.getByTestId('model-select')).getByRole('button');
  await user.click(select);await user.click(screen.getByRole('option',{name:/Mistral test/}));
  expect(screen.getByTestId('active-model-summary')).toHaveTextContent('Model changed to Mistral test. Your next request will use this model.');
  expect(select).toHaveFocus();
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Find a Lucario');
  await user.click(screen.getByRole('button',{name:'Send request'}));
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'Purchase request'})).toBeEnabled());
  const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/executions'))!;
  expect(JSON.parse(String(call[1]?.body)).model_id).toBe('mistral-test');
  expect(screen.getByText('Find a Lucario')).toBeInTheDocument();
  await user.click(within(screen.getByTestId('model-select')).getByRole('button'));await user.click(screen.getByRole('option',{name:/GPT test/}));
  expect(screen.getByText('Find a Lucario')).toBeInTheDocument();
  expect(screen.getByTestId('active-model-summary')).toHaveTextContent('Model changed to GPT test.');
});

it('explains why chat is unavailable when no model is enabled',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>json([])));
  render(<Chat token="token"/>);
  expect(await screen.findByText('An administrator must enable a model before you can send a request.')).toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:'Purchase request'})).toBeDisabled();
});

it('disables model and history changes during a running execution',async()=>{
  let complete!:(response:Response)=>void;
  const pending=new Promise<Response>(resolve=>{complete=resolve;});
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/models')?json([{id:'test',label:'GPT test',provider:'openai',api_id:'test',enabled:true}]):path.endsWith('/conversations')?json([]):pending));
  const user=userEvent.setup();render(<Chat token="token"/>);
  await screen.findByText('GPT test');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Find Lucario');
  await user.click(screen.getByRole('button',{name:'Send request'}));
  expect(within(screen.getByTestId('model-select')).getByRole('button')).toBeDisabled();
  expect(screen.getByTestId('new-conversation-button')).toBeDisabled();
  complete(new Response('event: done\ndata: {"status":"complete"}\n\n'));
  await waitFor(()=>expect(within(screen.getByTestId('model-select')).getByRole('button')).toBeEnabled());
});

it('confirms the named authenticator before sending a removal request',async()=>{
  const credential={id:'key-one',name:'Fixture physical key',created_at:'2026-11-01T00:00:00Z',device_type:'singleDevice',backed_up:false};
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>json(options?.method==='DELETE'?{removed:true}:[credential])));
  const user=userEvent.setup(),changed=vi.fn();render(<WebAuthnSettings token="token" onChange={changed}/>);
  await user.click(screen.getByRole('button',{name:'Passkeys and security keys'}));
  await user.click(await screen.findByRole('button',{name:'Remove Fixture physical key'}));
  const dialog=screen.getByRole('dialog',{name:'Remove Fixture physical key?'});
  expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='DELETE')).toBe(false);
  await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Remove Fixture physical key'}));
  await user.click(screen.getByRole('button',{name:'Remove authenticator'}));
  await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
  expect(vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='DELETE')?.[0]).toContain('/credentials/key-one');
});

it('keeps budget caveats visible and exposes the original offers, deck and sources through tabs',async()=>{
  const result:Result={plan:{cards:[card],format:'expanded',sources:[source],explanation:'Fixture plan'},legality,offers:[{id:'offer',name:card.name,supplier:'Fixture supplier',price:'2.00',currency:'USD',quantity:4,availability:'available',price_kind:'listing',condition:'NM',language:'English',printing:'Holofoil',source}],supplier_errors:[],recommendation:'Fixture recommendation',missing:[],budgets:[{supplier:'Fixture supplier',currency:'USD',complete:true,product_subtotal:'8.00',known_shipping:null,shipping_confirmed:false,confirmed_total:null,lines:[]}]};
  const user=userEvent.setup();render(<BudgetResults result={result}/>);
  expect(screen.getByText('Format legality: unverified')).toBeInTheDocument();
  expect(screen.getByText('Synthetic legality evidence only')).toBeInTheDocument();
  expect(within(screen.getByTestId('budget-section')).getByText('Unknown')).toBeInTheDocument();
  expect(within(screen.getByTestId('budget-section')).getByText('Unavailable')).toBeInTheDocument();
  await user.click(screen.getByRole('tab',{name:'Offers (1)'}));
  expect(screen.getByTestId('offers-table')).toHaveTextContent('2.00 USD (listing)');
  expect(screen.getByTestId('offer-source-link')).toHaveAttribute('href',source.url);
  await user.click(screen.getByRole('tab',{name:'Sources'}));
  await user.click(screen.getByRole('button',{name:'Sources and retrieval dates (1)'}));
  expect(screen.getAllByTestId('source-link')).toHaveLength(1);
  expect(screen.getByTestId('source-link')).toHaveAttribute('href',source.url);
  await user.click(screen.getByRole('tab',{name:'Deck'}));
  expect(screen.getByRole('img',{name:'Test ex card'})).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Table'}));
  expect(screen.getByTestId('deck-table')).toHaveTextContent('NM · English · Holofoil');
});
