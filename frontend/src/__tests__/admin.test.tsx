import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {Admin} from '../Admin';

afterEach(()=>vi.unstubAllGlobals());
const model={id:'gpt-6-luna',label:'GPT 6 luna',provider:'openai',api_id:'gpt-6-luna',enabled:false,verified_at:null};
const second={...model,id:'mistral-medium-latest',label:'Mistral Medium',provider:'mistral',api_id:'mistral-medium-latest'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function mockModels(items=[model]) {
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>json(path.includes('/accounts')?[]:options?.method==='PUT'?model:items)));
}

it('edits a named policy in context and confirms the model and enabled state after saving',async()=>{
  mockModels();const user=userEvent.setup();render(<Admin token="admin-token"/>);
  await user.click(await screen.findByRole('button',{name:'Edit GPT 6 luna'}));
  const dialog=screen.getByRole('dialog',{name:'Edit GPT 6 luna'});
  expect(within(dialog).getByLabelText('Registry identifier')).toBeDisabled();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await user.click(within(dialog).getByRole('checkbox',{name:'Enabled for agent use'}));
  await user.click(within(dialog).getByRole('button',{name:'Save model policy'}));
  expect(await screen.findByText('GPT 6 luna model policy saved. Enabled in chat.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const call=vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='PUT')!;
  expect(String(call[0])).toContain('/models/gpt-6-luna');
  expect(JSON.parse(String(call[1]!.body))).toEqual({label:'GPT 6 luna',provider:'openai',api_id:'gpt-6-luna',enabled:true});
});

it('keeps a rejected policy and server error inside its editor for correction',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>options?.method==='PUT'?json({error:{message:'API ID unavailable'}},422):json(path.includes('/accounts')?[]:[model])));
  const user=userEvent.setup();render(<Admin token="admin-token"/>);
  await user.click(await screen.findByRole('button',{name:'Edit GPT 6 luna'}));
  const dialog=screen.getByRole('dialog');
  await user.clear(within(dialog).getByLabelText('Provider API identifier'));
  await user.type(within(dialog).getByLabelText('Provider API identifier'),'not-available');
  await user.click(within(dialog).getByRole('button',{name:'Save model policy'}));
  expect(await within(dialog).findByText('API ID unavailable')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Provider API identifier')).toHaveValue('not-available');
});

it('protects unsaved edits and restores row focus when changes are discarded',async()=>{
  mockModels([model,second]);const user=userEvent.setup();render(<Admin token="admin-token"/>);
  const edit=await screen.findByRole('button',{name:'Edit Mistral Medium'});
  await user.click(edit);
  await user.clear(screen.getByLabelText('Display label'));await user.type(screen.getByLabelText('Display label'),'Changed name');
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  expect(screen.getByRole('dialog',{name:'Discard model changes?'})).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Keep editing'}));
  expect(screen.getByLabelText('Display label')).toHaveValue('Changed name');
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await user.click(screen.getByRole('button',{name:'Discard changes'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(edit).toHaveFocus();
  expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='PUT')).toBe(false);
  await user.click(screen.getByRole('button',{name:'Edit GPT 6 luna'}));
  expect(screen.getByLabelText('Display label')).toHaveValue('GPT 6 luna');
});

it('shows field validation and keeps creation separate from existing policies',async()=>{
  mockModels();const user=userEvent.setup();render(<Admin token="admin-token"/>);
  await screen.findByText('Disabled');await user.click(screen.getByRole('button',{name:'Create model policy'}));
  await user.click(screen.getByRole('button',{name:'Save model policy'}));
  expect(screen.getByText('Enter a registry identifier.')).toBeInTheDocument();
  expect(screen.getByText('Enter a display label.')).toBeInTheDocument();
  await user.click(within(screen.getByTestId('admin-model-preset-select')).getByRole('button'));
  await user.click(screen.getByRole('option',{name:'GPT 6 luna'}));
  await user.click(screen.getByRole('button',{name:'Save model policy'}));
  expect(screen.getByText('This identifier already exists. Edit that model instead.')).toBeInTheDocument();
  expect(screen.getByRole('checkbox',{name:'Enabled for agent use'})).not.toBeChecked();
  expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='PUT')).toBe(false);
});

it('validates account fields without a request and submits the same account contract',async()=>{
  mockModels();const user=userEvent.setup();render(<Admin token="admin-token" section="accounts"/>);
  await user.click(screen.getByRole('button',{name:'Create account'}));
  const dialog=screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('button',{name:'Create account'}));
  expect(screen.getByText('Enter a username.')).toBeInTheDocument();
  expect(screen.getByText('Use a password between 12 and 256 characters.')).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
  await user.type(screen.getByLabelText('New username'),'fixture-user');
  await user.type(screen.getByLabelText('Initial password'),'fixture-password-long');
  await user.click(within(dialog).getByRole('button',{name:'Create account'}));
  expect(await screen.findByText('Account fixture-user created.')).toBeInTheDocument();
  const call=vi.mocked(fetch).mock.calls.find(call=>call[1]?.method==='POST')!;
  expect(JSON.parse(String(call[1]!.body))).toEqual({username:'fixture-user',password:'fixture-password-long',role:'user'});
});

it('filters the model collection and provides recovery from zero matches',async()=>{
  mockModels([model,second]);const user=userEvent.setup();render(<Admin token="admin-token"/>);
  await screen.findByRole('button',{name:'Edit Mistral Medium'});
  await user.type(screen.getByRole('searchbox',{name:'Find models'}),'mistral');
  expect(screen.queryByRole('button',{name:'Edit GPT 6 luna'})).not.toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox',{name:'Find models'}));
  await user.type(screen.getByRole('searchbox',{name:'Find models'}),'no-match');
  expect(screen.getByText('No matches')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Clear filter'}));
  expect(screen.getByRole('button',{name:'Edit GPT 6 luna'})).toBeInTheDocument();
});

it('maps execution statuses consistently for table and modal status indicators and isolates row loading state',async()=>{
  const {AdminActivity, statusIndicatorType} = await import('../AdminActivity');
  expect(statusIndicatorType('complete')).toBe('success');
  expect(statusIndicatorType('running')).toBe('loading');
  expect(statusIndicatorType('failed')).toBe('error');
  expect(statusIndicatorType('cancelled')).toBe('stopped');
  expect(statusIndicatorType('waiting')).toBe('info');

  let resolveDetail!: (res: Response) => void;
  const detailPromise = new Promise<Response>((resolve) => { resolveDetail = resolve; });
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (path.includes('/api/admin/activity/exec-1')) return detailPromise;
    if (path.includes('/api/admin/activity')) {
      return Promise.resolve(json([
        {id: 'exec-11111111', user_id: 'u1', conversation_id: 'c1', conversation_title: 'First Deck', model_id: 'gpt-6-luna', status: 'failed', created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z'},
        {id: 'exec-22222222', user_id: 'u1', conversation_id: 'c2', conversation_title: 'Second Deck', model_id: 'gpt-6-luna', status: 'complete', created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z'},
      ]));
    }
    return Promise.resolve(json({status: 'synced', last_refreshed_at: null, next_refresh_at: null, sets_count: 10, banned_count: 2}));
  }));

  const user = userEvent.setup();
  render(<AdminActivity token="admin-token" />);
  await screen.findByText('First Deck');
  const buttons = screen.getAllByRole('button', {name: /View reasoning & trace/i});
  expect(buttons).toHaveLength(2);
  await user.click(buttons[0]);
  expect(buttons[0]).toHaveAttribute('aria-disabled', 'true');
  expect(buttons[1]).not.toHaveAttribute('aria-disabled', 'true');

  resolveDetail(json({
    id: 'exec-11111111',
    user_id: 'u1',
    conversation_id: 'c1',
    conversation_title: 'First Deck',
    model_id: 'gpt-6-luna',
    status: 'failed',
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
    checkpoint: {},
    reasoning_summary: 'Failed during quote step.',
    events: [],
    logs: [],
  }));
  expect(await screen.findByRole('dialog', {name: /Execution Details — First Deck/i})).toBeInTheDocument();
});

it('AdminActivity renders the run selector when thread_executions has 2 or more entries, and clicking another run loads that execution detail', async () => {
  const { AdminActivity } = await import('../AdminActivity');
  const user = userEvent.setup();

  const run1Summary = {
    id: 'exec-11111111-aaaa',
    conversation_id: 'conv-multi',
    conversation_title: 'Multi-turn Run',
    user_id: 'u1',
    model_id: 'gpt-6-luna',
    status: 'failed',
    created_at: '2026-11-10T00:00:00Z',
  };
  const run2Summary = {
    id: 'exec-22222222-bbbb',
    conversation_id: 'conv-multi',
    conversation_title: 'Multi-turn Run',
    user_id: 'u1',
    model_id: 'mistral-medium-latest',
    status: 'complete',
    created_at: '2026-11-10T01:00:00Z',
  };

  const run1Detail = {
    ...run1Summary,
    checkpoint: {},
    reasoning_summary: 'Run 1 reasoning',
    events: [],
    logs: [],
    messages: [
      { id: 'm1', role: 'user', content: { text: 'Prompt 1' }, created_at: '2026-11-10T00:00:00Z' },
    ],
    thread_executions: [run1Summary, run2Summary],
  };

  const run2Detail = {
    ...run2Summary,
    checkpoint: {},
    reasoning_summary: 'Run 2 reasoning',
    events: [],
    logs: [],
    messages: [
      { id: 'm1', role: 'user', content: { text: 'Prompt 1' }, created_at: '2026-11-10T00:00:00Z' },
      { id: 'm2', role: 'user', content: { text: 'Prompt 2' }, created_at: '2026-11-10T01:00:00Z' },
    ],
    thread_executions: [run1Summary, run2Summary],
  };

  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (path.includes('/api/admin/activity/exec-22222222-bbbb')) {
      return Promise.resolve(json(run2Detail));
    }
    if (path.includes('/api/admin/activity/exec-11111111-aaaa')) {
      return Promise.resolve(json(run1Detail));
    }
    if (path.includes('/api/admin/activity')) {
      return Promise.resolve(json([run1Summary]));
    }
    if (path.includes('/api/chat/models')) {
      return Promise.resolve(json([
        { id: 'gpt-6-luna', label: 'GPT 6 luna' },
        { id: 'mistral-medium-latest', label: 'Mistral Medium' },
      ]));
    }
    if (path.includes('/api/admin/legality/status')) {
      return Promise.resolve(json({ status: 'synced', sets_count: 5 }));
    }
    return Promise.resolve(json({}));
  }));

  render(<AdminActivity token="admin-token" />);

  // Switch to Agent Playground view
  const playgroundButton = await screen.findByRole('button', { name: /Foundry Agentic Playground/i });
  await user.click(playgroundButton);

  // In the left sidebar thread list, click the conversation thread to select it
  const threadCard = await screen.findByText('Multi-turn Run');
  await user.click(threadCard);

  // Verify run selector is rendered with both runs
  const runSelector = await screen.findByTestId('run-selector');
  const run1Button = within(runSelector).getAllByRole('button', { name: /exec-111/ })[0];
  const run2Button = within(runSelector).getAllByRole('button', { name: /exec-222/ })[0];
  expect(run1Button).toBeInTheDocument();
  expect(run2Button).toBeInTheDocument();

  // Click the second run option
  await user.click(run2Button);

  // Verify handleViewDetail was called for exec-22222222-bbbb and loaded run2 detail
  await waitFor(() => {
    const detailCall = vi.mocked(fetch).mock.calls.find((c) => String(c[0]).includes('exec-22222222-bbbb'));
    expect(detailCall).toBeDefined();
  });
  expect(await screen.findByText('Prompt 2')).toBeInTheDocument();
});
