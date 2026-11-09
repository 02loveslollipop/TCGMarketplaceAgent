import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Chat} from '../Chat';
import type {AgentEvent,Question,Result} from '../contracts';
const model={id:'test-model',label:'Test model',provider:'openai',api_id:'test',enabled:true};
const usage={daily_token_limit:50000,total_tokens:100,remaining_tokens:49900,unverified_usage:false,in_progress:false};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const sse=(events:AgentEvent[])=>new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''));
const completed={type:'done',data:{status:'complete'}} as const;
const result:Result={plan:{format:'expanded',cards:[],sources:[],explanation:'Fixture plan'},legality:{status:'unverified',issues:[],sources:[]},offers:[],budgets:[],missing:[],supplier_errors:[],recommendation:'Fixture recommendation'};
function defaults(path:string){if(path.endsWith('/models'))return json([model]);if(path.endsWith('/usage'))return json(usage);if(path.endsWith('/conversations'))return json([]);return sse([completed]);}
afterEach(()=>vi.unstubAllGlobals());

it('inserts an editable starter prompt without sending a model request',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>defaults(path)));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.click(screen.getByRole('menuitem',{name:'Edit prompt: Find exact card printings'}));
  expect((screen.getByRole('textbox',{name:'Purchase request'}) as HTMLTextAreaElement).value).toContain('<card-name>');
  expect(screen.getByRole('textbox',{name:'Purchase request'})).toHaveFocus();
  expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
});

it('keeps rich results outside the response bubble and sends the complete artifact to its review panel',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/executions')?sse([{type:'result',data:result},completed]):defaults(path)));
  const user=userEvent.setup(),preview=vi.fn();render(<Chat token="fixture" onPreview={preview}/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Find my cards');await user.click(screen.getByRole('button',{name:'Send request'}));
  const card=await screen.findByTestId('chat-artifact-preview');
  const response=screen.getByRole('group',{name:'Agent budget result'});
  expect(response).not.toContainElement(card);
  expect(screen.queryByRole('tab',{name:'Deck'})).not.toBeInTheDocument();
  await user.click(within(card).getByRole('button',{name:'Review deck and budget'}));
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({kind:'budget',result}));
});

it('searches saved conversations and restores a resumable decision with its original scope',async()=>{
  const question:Question={kind:'missing_cards',question:'Keep these printings unquoted?',missing:[{card_id:'card',name:'Fixture card',number:'7',quantity:2,language:'English',condition:'NM',printing:'Holofoil'}],actions:['keep_missing','cancel']};
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
    if(path.endsWith('/conversations'))return json([{id:'old',title:'Older deck'},{id:'waiting',title:'Waiting Lucario deck'}]);
    if(path.endsWith('/conversations/waiting'))return json([{role:'user',created_at:'2026-11-09T00:00:00Z',content:{text:'Find my Lucario cards'}},{role:'assistant',content:{type:'question',data:question,execution_id:'waiting-execution'}}]);
    if(path.endsWith('/executions/waiting-execution'))return json({status:'waiting'});
    if(path.endsWith('/resume'))return sse([{type:'result',data:result},completed]);
    return defaults(path);
  }));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByRole('button',{name:'Waiting Lucario deck'});
  await user.type(screen.getByRole('searchbox',{name:'Find a conversation'}),'Lucario');
  expect(screen.queryByRole('button',{name:'Older deck'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Waiting Lucario deck'}));
  const keep=await screen.findByRole('button',{name:'Keep listed cards missing'});
  expect(keep).toBeDisabled();expect(screen.queryByRole('button',{name:'Research substitutes'})).not.toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:'Purchase request'})).toBeDisabled();
  await user.click(screen.getByRole('checkbox'));await user.click(keep);
  expect(await screen.findByText('Approved keeping the listed cards missing: 2 × Fixture card #7 (English · NM · Holofoil).')).toBeInTheDocument();
  const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/waiting-execution/resume'))!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({action:'keep_missing',approved:true});
  expect(screen.queryByRole('button',{name:'Keep listed cards missing'})).not.toBeInTheDocument();
});

it('restores recorded decisions from history instead of losing the user’s consent message',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
    if(path.endsWith('/conversations'))return json([{id:'saved',title:'Saved decision'}]);
    if(path.endsWith('/conversations/saved'))return json([{role:'assistant',content:{type:'question',data:{kind:'missing_cards',question:'Missing cards?',missing:[{card_id:'one',name:'Card One',quantity:1}],actions:['keep_missing']}}},{role:'user',content:{decision:{action:'keep_missing',approved:true}}},{role:'assistant',content:{type:'result',data:result}}]);
    return defaults(path);
  }));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await user.click(await screen.findByRole('button',{name:'Saved decision'}));
  expect(await screen.findByText('Approved keeping the listed cards missing: 1 × Card One.')).toBeInTheDocument();
  expect(screen.getByText('Approved for the listed cards')).toBeInTheDocument();
});

it('stops an active stream immediately and records the stop without an approval dialog',async()=>{
  let signal:AbortSignal|undefined;
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{
    if(!path.endsWith('/executions'))return defaults(path);
    signal=options?.signal as AbortSignal;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: execution\ndata: {"id":"run","conversation_id":"chat"}\n\n'));signal!.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')));}}));
  }));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Work slowly');await user.click(screen.getByRole('button',{name:'Send request'}));
  await user.click(await screen.findByRole('button',{name:'Stop execution'}));
  expect(signal?.aborted).toBe(true);expect(await screen.findByText('You stopped this execution.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Stop execution'})).not.toBeInTheDocument());
});

it('preserves the reader’s scroll position while new activity arrives and offers a jump action',async()=>{
  let emit!:ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/executions')?new Response(new ReadableStream({start(controller){emit=controller;}})):defaults(path)));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Research cards');await user.click(screen.getByRole('button',{name:'Send request'}));
  const log=screen.getByRole('region',{name:'Chat'});
  Object.defineProperties(log,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});
  log.scrollTop=150;fireEvent.scroll(log);
  await act(async()=>emit.enqueue(new TextEncoder().encode('event: progress\ndata: {"step":"research","message":"Searching sources"}\n\n')));
  expect(log.scrollTop).toBe(150);
  await user.click(await screen.findByRole('button',{name:'Jump to latest'}));expect(log.scrollTop).toBe(1000);
  await act(async()=>{emit.enqueue(new TextEncoder().encode('event: done\ndata: {"status":"complete"}\n\n'));emit.close();});
});

it('reuses an original request as an editable draft without pretending to regenerate a response',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>defaults(path)));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Original exact request');await user.click(screen.getByRole('button',{name:'Send request'}));
  const edit=await screen.findByRole('button',{name:'Edit and reuse request'});await waitFor(()=>expect(edit).toBeEnabled());await user.click(edit);
  expect(screen.getByRole('textbox',{name:'Purchase request'})).toHaveValue('Original exact request');
  expect(vi.mocked(fetch).mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});


it.each([
  {events:[{type:'error',data:{message:'Research is unavailable'}},{type:'done',data:{status:'failed'}}] as AgentEvent[],message:'Research is unavailable'},
  {events:[] as AgentEvent[],message:'The response ended before completion. Review the activity and retry your request.'}
])('keeps stream failures visible once and releases the composer: $message',async({events,message})=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.endsWith('/executions')?sse(events):defaults(path)));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Research a deck');await user.click(screen.getByRole('button',{name:'Send request'}));
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getAllByText(message)).toHaveLength(1);
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'Purchase request'})).not.toHaveAttribute('readonly'));
  await user.click(screen.getByRole('button',{name:'Edit and reuse request'}));
  expect(screen.getByRole('textbox',{name:'Purchase request'})).toHaveValue('Research a deck');
});

it('pastes image context, removes previews and submits real image data with an image-only request',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>defaults(path)));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  const file=new File([new Uint8Array([137,80,78,71])],'cards.png',{type:'image/png'});
  fireEvent.paste(screen.getByRole('textbox',{name:'Purchase request'}),{clipboardData:{files:[file]}});
  const remove=await screen.findByRole('button',{name:'Remove cards.png'});await user.click(remove);
  expect(screen.queryByRole('button',{name:'Remove cards.png'})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Send request'})).toBeDisabled();
  fireEvent.paste(screen.getByRole('textbox',{name:'Purchase request'}),{clipboardData:{files:[file]}});
  await screen.findByRole('button',{name:'Remove cards.png'});
  await user.click(screen.getByRole('button',{name:'Send request'}));
  const call=vi.mocked(fetch).mock.calls.find(call=>String(call[0]).endsWith('/executions'))!;
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({text:'',images:[{name:'cards.png',media_type:'image/png',data_url:'data:image/png;base64,iVBORw=='}]});
  expect(screen.getByRole('img',{name:'Image context: cards.png'})).toBeInTheDocument();
  await user.click(await screen.findByRole('button',{name:'Edit and reuse request'}));
  expect(await screen.findByRole('button',{name:'Remove cards.png'})).toBeInTheDocument();
});

it('rejects unsupported, oversized and excess image attachments before making a model request',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>defaults(path)));
  render(<Chat token="fixture"/>);await screen.findByText('Test model');
  const prompt=screen.getByRole('textbox',{name:'Purchase request'});
  fireEvent.paste(prompt,{clipboardData:{files:[new File(['<svg/>'],'test.svg',{type:'image/svg+xml'})]}});
  expect(await screen.findByText('Use PNG, JPEG or WebP images.')).toBeInTheDocument();
  fireEvent.paste(prompt,{clipboardData:{files:[new File([new Uint8Array(2*1024*1024+1)],'huge.png',{type:'image/png'})]}});
  expect(await screen.findByText('Each image must be at most 2 MiB.')).toBeInTheDocument();
  fireEvent.paste(prompt,{clipboardData:{files:Array.from({length:4},()=>new File(['x'],'test.png',{type:'image/png'}))}});
  expect(await screen.findByText('Attach up to 3 images per request.')).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
});

it('shows collapsed provider reasoning and restores saved history without mixing in tool calls',async()=>{
  const thought={type:'thinking',data:{id:'reasoning-1',source:'provider_summary',status:'complete',summary:'Compare the verified printings first.'}} as const;
  const tool:Extract<AgentEvent,{type:'tool'}>={type:'tool',data:{id:'tool-1',name:'search_cards',status:'complete',input:{name:'Lucario'},sources:[{url:'https://example.com/cards',title:'Verified card source'}],duration_ms:200}};
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
    if(path.endsWith('/conversations'))return json([{id:'trace',title:'Saved research trace'}]);
    if(path.endsWith('/conversations/trace'))return json([{role:'user',content:{text:'Find Lucario'}},{role:'assistant',content:thought},{role:'assistant',content:tool},{role:'assistant',content:{type:'result',data:result}}]);
    if(path.endsWith('/executions'))return sse([{...thought,data:{...thought.data,status:'loading',summary:'Compare'}},thought,tool,{type:'result',data:result},completed]);
    return defaults(path);
  }));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Find cards');await user.click(screen.getByRole('button',{name:'Send request'}));
  const expand=await screen.findByRole('button',{name:'Completed thinking'});
  expect(expand).toHaveAttribute('aria-expanded','false');await user.click(expand);
  expect(screen.getAllByText('Compare the verified printings first.')).toHaveLength(1);
  expect(screen.queryByRole('list',{name:'Tool call search_cards'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Saved research trace'}));
  await user.click(await screen.findByRole('button',{name:'Completed thinking'}));
  expect(screen.getAllByText('Compare the verified printings first.')).toHaveLength(1);
  expect(screen.queryByRole('list',{name:'Tool call search_cards'})).not.toBeInTheDocument();
});

it('keeps reasoning updates scoped to their own request and labels unfinished summaries as interrupted',async()=>{
  let request=0;
  const thought=(summary:string,status:'loading'|'complete'):AgentEvent=>({type:'thinking',data:{id:'provider-reused-id',source:'provider_summary',summary,status}});
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
    if(path.endsWith('/executions'))return sse(request++===0?[thought('First completed summary','complete'),completed]:[thought('Second unfinished summary','loading'),{type:'error',data:{message:'Provider interrupted'}}]);
    return defaults(path);
  }));
  const user=userEvent.setup();render(<Chat token="fixture"/>);await screen.findByText('Test model');
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'First request');await user.click(screen.getByRole('button',{name:'Send request'}));
  await screen.findByRole('button',{name:'Completed thinking'});
  await user.type(screen.getByRole('textbox',{name:'Purchase request'}),'Second request');await user.click(screen.getByRole('button',{name:'Send request'}));
  await user.click(await screen.findByRole('button',{name:'Thinking interrupted'}));
  await user.click(screen.getByRole('button',{name:'Completed thinking'}));
  expect(screen.getByText('First completed summary')).toBeInTheDocument();
  expect(screen.getByText('Second unfinished summary')).toBeInTheDocument();
  expect(screen.getByText('Summary interrupted')).toBeInTheDocument();
});
