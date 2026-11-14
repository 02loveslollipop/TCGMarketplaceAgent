import {StrictMode} from 'react';
import {render,screen,waitFor,within,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ApiTokenShell} from '../ApiTokenShell';
import {registerTokenRefresher,setLatestToken} from '../client';
import type {Result,Session} from '../contracts';

const TOKEN_A = 'tcg_api_synthetic_alpha_0001';
const TOKEN_B = 'tcg_api_synthetic_bravo_0002';

function makeApiSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'principal-alpha-id',
    username: 'ci-deck-bot',
    role: 'custom',
    role_name: 'Agent Tester',
    principal_type: 'api',
    key_reference: 'tcg_api_syn...0001',
    totp_enrolled: false,
    webauthn_enrolled: false,
    webauthn_credentials_count: 0,
    policy_statements: [
      { effect: 'Allow', actions: ['agent:*'], resources: ['*'] },
    ],
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeControlledSse() {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    send(event: string, data: unknown) {
      controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

const SAMPLE_RESULT: Result = {
  plan: {
    purpose: 'deck',
    format: 'Standard',
    explanation: 'Synthetic card selection for test verification.',
    sources: [{ url: 'https://tcgdex.example.test/cards/1', title: 'TCGdex Reference', retrieved_at: '2026-11-14T00:00:00Z' }],
    cards: [
      {
        card_id: 'sv1-1',
        name: 'Lucario',
        quantity: 2,
        set_name: 'Scarlet & Violet',
        number: '114',
        condition: 'Near Mint',
        language: 'English',
        printing: 'Regular',
        image_url: null,
      },
    ],
  },
  legality: {
    status: 'verified',
    issues: [],
    sources: [{ url: 'https://tcgdex.example.test/legality', title: 'Standard Legality', retrieved_at: '2026-11-14T00:00:00Z' }],
  },
  offers: [
    {
      id: 'offer-1',
      name: 'Lucario - 114',
      supplier: 'Synthetic Card Shop',
      price: '2.50',
      currency: 'USD',
      quantity: 4,
      availability: 'in_stock',
      price_kind: 'verified',
      number: '114',
      printing: 'Regular',
      condition: 'Near Mint',
      language: 'English',
      source: { url: 'https://shop.example.test/lucario-114', title: 'Synthetic Card Shop', retrieved_at: '2026-11-14T00:00:00Z' },
    },
  ],
  budgets: [
    {
      supplier: 'Synthetic Card Shop',
      currency: 'USD',
      complete: true,
      product_subtotal: '5.00',
      known_shipping: null,
      shipping_confirmed: false,
      confirmed_total: null,
      lines: [
        {
          card_id: 'sv1-1',
          name: 'Lucario',
          requested: 2,
          covered: 2,
          set_name: 'Scarlet & Violet',
          number: '114',
          condition: 'Near Mint',
          language: 'English',
          printing: 'Regular',
          allocations: [
            {
              offer_id: 'offer-1',
              supplier: 'Synthetic Card Shop',
              quantity: 2,
              unit_price: '2.50',
              line_total: '5.00',
              url: 'https://shop.example.test/lucario-114',
            },
          ],
        },
      ],
    },
  ],
  missing: [],
  supplier_errors: [],
  recommendation: 'Buy 2 copies of Lucario from Synthetic Card Shop for $5.00 USD before shipping.',
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = '';
  document.body.dataset.colorTheme = 'light';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  registerTokenRefresher(async () => null);
  setLatestToken('');
});

describe('API token chat test client', () => {
  it('consumes a Docker launch token once under StrictMode and clears it on disconnect', async () => {
    const bootstrapToken=vi.fn(async()=>TOKEN_A);
    vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
      const url=String(input);
      if(url==='/api/auth/session')return jsonResponse(makeApiSession());
      if(url==='/api/chat/models')return jsonResponse([]);
      if(url==='/api/chat/conversations')return jsonResponse([]);
      if(url==='/api/chat/usage')return jsonResponse({daily_token_limit:5000,total_tokens:0,remaining_tokens:5000});
      throw new Error('Unexpected request');
    });
    const user=userEvent.setup();
    render(<StrictMode><ApiTokenShell bootstrapToken={bootstrapToken}/></StrictMode>);
    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('ci-deck-bot');
    expect(bootstrapToken).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button',{name:'Disconnect'}));
    expect(screen.getByTestId('api-token-input')).toHaveValue('');
    expect(bootstrapToken).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('token')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps manual connection available when the Docker launch token has already been consumed', async () => {
    render(<ApiTokenShell bootstrapToken={async()=>null}/>);
    await waitFor(()=>expect(screen.getByTestId('api-token-input')).toBeEnabled());
    expect(screen.getByTestId('api-token-input')).toHaveValue('');
    expect(screen.queryByTestId('api-token-connect-error')).not.toBeInTheDocument();
  });

  it('prevents manual connection races during bootstrap and permits retry after bootstrap failure', async () => {
    let rejectBootstrap!: (reason:Error)=>void;
    const bootstrapToken=()=>new Promise<string|null>((_resolve,reject)=>{rejectBootstrap=reject;});
    render(<ApiTokenShell bootstrapToken={bootstrapToken}/>);
    expect(screen.getByTestId('api-token-input')).toBeDisabled();
    rejectBootstrap(new Error('Synthetic startup failure'));
    await waitFor(()=>expect(screen.getByTestId('api-token-input')).toBeEnabled());
    expect(screen.getByTestId('api-token-connect-error')).toHaveTextContent('Enter an API token to connect.');
  });

  it('validates blank and whitespace tokens inline with focus and enabled Connect button', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<ApiTokenShell />);

    const connectBtn = screen.getByTestId('api-token-connect-button');
    const input = screen.getByTestId('api-token-input') as HTMLInputElement;

    expect(connectBtn).toBeEnabled();
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(screen.getByText('/api/auth/session')).toBeInTheDocument();
    expect(screen.getByText('/api/chat')).toBeInTheDocument();

    await user.click(connectBtn);
    expect(await screen.findByText('Enter an API token before connecting.')).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.type(input, 'tcg_api_bad whitespace');
    await user.click(connectBtn);
    expect(await screen.findByText('API token cannot contain spaces or line breaks.')).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects 401 tokens and human user sessions without calling chat, admin, portal, refresh, or logout routes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/auth/session')) {
        return jsonResponse({ error: { code: 'invalid_token', message: 'Token revoked.' } }, 401);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<ApiTokenShell />);

    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    expect(await screen.findByTestId('api-token-connect-error')).toHaveTextContent('Token revoked.');
    expect(screen.queryByTestId('api-principal-banner')).not.toBeInTheDocument();

    fetchMock.mockImplementationOnce(async (input) => {
      expect(String(input)).toBe('/api/auth/session');
      return jsonResponse({
        ...makeApiSession({ principal_type: 'user', username: 'alice', role: 'user', key_reference: null }),
      });
    });

    await user.clear(screen.getByTestId('api-token-input'));
    await user.type(screen.getByTestId('api-token-input'), 'human_jwt_fake');
    await user.click(screen.getByTestId('api-token-connect-button'));

    expect(await screen.findByTestId('api-token-connect-error')).toHaveTextContent('human user session');
    expect(screen.queryByTestId('api-principal-banner')).not.toBeInTheDocument();

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    for (const url of calledUrls) {
      expect(url).toBe('/api/auth/session');
      expect(url).not.toMatch(/portal-session|refresh|token|logout|\/api\/admin|\/api\/chat/);
    }
  });

  it('enforces credentials:omit, never reads latestToken or refresher on 401, and invalidates connection cleanly on mid-session 401 without logout or POST retry', async () => {
    const refresherSpy = vi.fn(async () => 'human_refreshed_should_never_be_used');
    registerTokenRefresher(refresherSpy);
    setLatestToken('human_latest_should_never_be_used');

    let executionAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.credentials).toBe('omit');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN_A}`);

      if (url === '/api/auth/session') return jsonResponse(makeApiSession());
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT Test', provider: 'openai', api_id: 'gpt-test', enabled: true }]);
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/usage') {
        return jsonResponse({ daily_token_limit: 50000, total_tokens: 1000, remaining_tokens: 49000, unverified_usage: false, in_progress: false });
      }
      if (url === '/api/chat/executions') {
        executionAttempts += 1;
        return jsonResponse({ error: { code: 'invalid_token', message: 'API token expired.' } }, 401);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);
    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('ci-deck-bot');
    const promptTextarea = await screen.findByTestId('chat-prompt-textarea');
    await user.type(promptTextarea, 'Build Lucario deck');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      expect(screen.getByTestId('api-token-connect-error')).toHaveTextContent('401');
    });
    expect(screen.getByTestId('api-token-connect-error')).toHaveTextContent('API token expired.');
    expect(executionAttempts).toBe(1);
    expect(refresherSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/logout'))).toBe(false);
    expect(screen.queryByTestId('api-principal-banner')).not.toBeInTheDocument();
  });

  it('distinguishes 403 permission denials, missing optional permissions, empty models, and zero quotas without false invalidation or fake zero usage', async () => {
    const limitedSession = makeApiSession({
      username: 'restricted-bot',
      policy_statements: [
        {
          effect: 'Allow',
          actions: ['agent:models:list', 'agent:executions:create', 'agent:conversations:read', 'agent:preferences:read'],
          resources: ['*'],
        },
        {
          effect: 'Deny',
          actions: ['agent:usage:read', 'agent:conversations:write', 'agent:conversations:delete', 'agent:preferences:write', 'agent:executions:read'],
          resources: ['*'],
        },
      ],
    });

    const calledUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      calledUrls.push(url);
      if (url === '/api/auth/session') return jsonResponse(limitedSession);
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT Test', provider: 'openai', api_id: 'gpt-test', enabled: true }]);
      }
      if (url === '/api/chat/conversations') {
        return jsonResponse([{ id: 'conv-1', title: 'Prior Research' }]);
      }
      if (url === '/api/chat/conversations/conv-1') {
        return jsonResponse([
          { role: 'user', content: { text: 'Need Lucario' } },
          { role: 'assistant', content: { type: 'question', execution_id: 'exec-9', data: { kind: 'clarification', question: 'Which format?', options: ['Standard'], actions: ['clarify'] } } },
        ]);
      }
      if (url === '/api/chat/executions') {
        return jsonResponse({ error: { message: 'Model m-gpt is not allowed for this role (403).' } }, 403);
      }
      if (url === '/api/chat/preferences') {
        return jsonResponse({ ruleset: 'auto', format: 'standard', location: 'Tokyo', target_currency: 'USD' });
      }
      if (url === '/api/chat/currencies') return jsonResponse(['USD', 'JPY']);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);
    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('restricted-bot');
    expect(calledUrls).not.toContain('/api/chat/usage');
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument();

    // Conversations visible without rename/delete actions when write/delete denied
    expect(await screen.findByText('Prior Research')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename conversation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete conversation/ })).not.toBeInTheDocument();

    // Inspector truthfully reports allowed vs denied capabilities
    await user.click(screen.getByRole('button', { name: 'Principal and debugging' }));
    expect(screen.getByTestId('capability-agent:executions:create')).toHaveTextContent('Allowed');
    expect(screen.getByTestId('capability-agent:usage:read')).toHaveTextContent('Denied');

    // Sending hitting 403 keeps principal connected
    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'Test 403');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/Model m-gpt is not allowed/)).toBeInTheDocument();
    expect(screen.getByTestId('api-principal-banner')).toBeInTheDocument();

    // Loading waiting question when agent:executions:read is missing shows loaded history + warning
    await user.click(screen.getByRole('button', { name: 'Prior Research' }));
    expect(await screen.findByText('Need Lucario')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-error')).toHaveTextContent('agent:executions:read');

    // Read-only preferences disables Save
    window.location.hash = 'preferences';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByText('Read-only preferences')).toBeInTheDocument();
    expect(screen.getByText(/Principal-owned preferences/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
  });

  it('shows accurate empty-model and zero-quota principal messages and clears state cleanly on Disconnect and principal swap without storage leaks', async () => {
    let activeToken = TOKEN_A;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization');
      expect(auth).toBe(`Bearer ${activeToken}`);

      if (url === '/api/auth/session') {
        return jsonResponse(
          activeToken === TOKEN_A
            ? makeApiSession({ id: 'id-a', username: 'principal-alpha', key_reference: 'alpha-ref' })
            : makeApiSession({ id: 'id-b', username: 'principal-bravo', key_reference: 'bravo-ref' }),
        );
      }
      if (url === '/api/chat/models') {
        return jsonResponse(
          activeToken === TOKEN_A
            ? []
            : [{ id: 'm-mistral', label: 'Mistral Test', provider: 'mistral', api_id: 'mistral-medium-latest', enabled: true }],
        );
      }
      if (url === '/api/chat/conversations') {
        return jsonResponse(
          activeToken === TOKEN_A
            ? [{ id: 'conv-a', title: 'Alpha Deck Only' }]
            : [{ id: 'conv-b', title: 'Bravo Deck Only' }],
        );
      }
      if (url === '/api/chat/usage') {
        return jsonResponse(
          activeToken === TOKEN_A
            ? { daily_token_limit: 0, total_tokens: 0, remaining_tokens: 0, unverified_usage: false, in_progress: false }
            : { daily_token_limit: 20000, total_tokens: 500, remaining_tokens: 19500, unverified_usage: false, in_progress: false },
        );
      }
      if (url === '/api/chat/preferences') {
        return jsonResponse({
          ruleset: activeToken === TOKEN_A ? 'japan' : 'international',
          format: 'standard',
          location: activeToken === TOKEN_A ? 'Osaka' : 'Bogota',
          target_currency: activeToken === TOKEN_A ? 'JPY' : 'COP',
        });
      }
      if (url === '/api/chat/currencies') return jsonResponse(['USD', 'JPY', 'COP']);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);

    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    expect(await screen.findByText('Alpha Deck Only')).toBeInTheDocument();
    expect(screen.getByTestId('active-model-summary')).toHaveTextContent('No enabled models are permitted for this API principal role.');
    expect(screen.getByText('This API principal role has a daily token limit of 0. Model calls are blocked.')).toBeInTheDocument();

    // Disconnect locally
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Connection closed')).toBeInTheDocument();
    expect(screen.getByTestId('api-token-input')).toHaveValue('');

    // Reconnect as Principal B
    activeToken = TOKEN_B;
    await user.type(screen.getByTestId('api-token-input'), TOKEN_B);
    await user.click(screen.getByTestId('api-token-connect-button'));

    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('principal-bravo');
    expect(await screen.findByText('Bravo Deck Only')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Deck Only')).not.toBeInTheDocument();

    // Preferences should load Principal B's values rather than cached Principal A state
    window.location.hash = 'preferences';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByDisplayValue('Bogota')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Osaka')).not.toBeInTheDocument();

    // Ensure token was never persisted anywhere
    const storageValues = setItemSpy.mock.calls.flatMap((args) => args.map(String)).join('\n');
    expect(storageValues).not.toContain(TOKEN_A);
    expect(storageValues).not.toContain(TOKEN_B);
    expect(window.location.href).not.toContain(TOKEN_A);
    expect(window.location.href).not.toContain(TOKEN_B);
    expect(document.cookie).not.toContain(TOKEN_A);
    expect(document.cookie).not.toContain(TOKEN_B);
  });

  it('supports SSE question/approval, SplitPanel result, execution snapshot debugging, incomplete streams, and local stop caveat', async () => {
    const sse1 = makeControlledSse();
    const sse2 = makeControlledSse();
    const sse3 = makeControlledSse();
    const sse4 = makeControlledSse();
    let streamCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.credentials).toBe('omit');
      if (url === '/api/auth/session') return jsonResponse(makeApiSession());
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT Test', provider: 'openai', api_id: 'gpt-test', enabled: true }]);
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/usage') {
        return jsonResponse({ daily_token_limit: 50000, total_tokens: 100, remaining_tokens: 49900, unverified_usage: false, in_progress: false });
      }
      if (url === '/api/chat/executions') {
        streamCount += 1;
        if (streamCount === 1) return sse1.response;
        if (streamCount === 2) return sse3.response;
        return sse4.response;
      }
      if (url === '/api/chat/executions/exec-101/resume') return sse2.response;
      if (url === '/api/chat/executions/exec-101') {
        return jsonResponse({
          id: 'exec-101',
          conversation_id: 'conv-101',
          status: 'completed',
          checkpoint: {},
          events: [{ type: 'execution', data: {} }, { type: 'result', data: {} }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);
    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'Build Lucario deck');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    sse1.send('execution', { id: 'exec-101', conversation_id: 'conv-101' });
    sse1.send('thinking', { id: 't-1', status: 'complete', source: 'approach_summary', summary: 'Checked Standard legality.' });
    sse1.send('question', {
      kind: 'deck_approval',
      question: 'Approve the 2 Lucario cards?',
      options: [],
      actions: ['approve_deck', 'cancel'],
      card_count: 2,
      unique_cards: 1,
      format: 'Standard',
      ruleset: 'international',
    });
    sse1.close();

    expect(await screen.findByText('Approve this deck')).toBeInTheDocument();
    expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('Exec: exec-101');

    // Open inspector and verify execution ID + conversation ID
    await user.click(screen.getByRole('button', { name: 'Principal and debugging' }));
    expect(screen.getByText('conv-101')).toBeInTheDocument();
    expect(screen.getByText('exec-101')).toBeInTheDocument();

    // Approve deck and finish SSE stream
    await user.click(screen.getByRole('button', { name: 'Approve and price this deck' }));
    sse2.send('result', SAMPLE_RESULT);
    sse2.send('done', { status: 'completed' });
    sse2.close();

    expect(await screen.findByText(/Buy 2 copies of Lucario/)).toBeInTheDocument();

    // Verify Read-only Refresh execution status
    await user.click(screen.getByTestId('refresh-execution-status-button'));
    expect(await screen.findByText('completed')).toBeInTheDocument();

    // Open SplitPanel preview and confirm Excel export action renders without credential exposure
    await user.click(screen.getByRole('button', { name: 'Review deck and budget' }));
    expect(await screen.findByTestId('budget-section')).toHaveTextContent('Synthetic Card Shop');
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN_A);

    // Incomplete stream preserves execution ID and shows warning status
    await user.type(screen.getByTestId('chat-prompt-textarea'), 'Test early EOF');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    sse3.send('execution', { id: 'exec-102', conversation_id: 'conv-101' });
    sse3.close();

    expect(await screen.findByText('The response ended before completion. Review the activity and retry your request.')).toBeInTheDocument();
    expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('Exec: exec-102');
    expect(screen.getByText('Stream ended early')).toBeInTheDocument();

    // Client-side stop shows both StatusIndicator and browser-only cancellation clarification
    await user.type(screen.getByTestId('chat-prompt-textarea'), 'Test stop caveat');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    sse4.send('execution', { id: 'exec-103', conversation_id: 'conv-101' });
    await user.click(await screen.findByRole('button', { name: 'Stop execution' }));

    expect(await screen.findByText('You stopped this execution.')).toBeInTheDocument();
    expect(await screen.findByText(/Browser SSE listening stopped/)).toBeInTheDocument();
  });

  it('handles 429 rate limits, unverified usage blocks, and connect network failures without retrying POST requests', async () => {
    let execPosts = 0;
    let resumePosts = 0;
    let simulateUnverified = false;
    const sseWait = makeControlledSse();

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/auth/session') {
        throw new TypeError('Failed to fetch');
      }
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT Test', provider: 'openai', api_id: 'gpt-test', enabled: true }]);
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/usage') {
        return jsonResponse({
          daily_token_limit: 50000,
          total_tokens: 1000,
          remaining_tokens: simulateUnverified ? 49000 : 49000,
          unverified_usage: simulateUnverified,
          in_progress: false,
        });
      }
      if (url === '/api/chat/executions') {
        execPosts += 1;
        if (execPosts === 1) {
          return jsonResponse({ error: { code: 'quota_exceeded', message: 'Daily token quota exceeded (429).' } }, 429);
        }
        return sseWait.response;
      }
      if (url === '/api/chat/executions/exec-201/resume') {
        resumePosts += 1;
        return jsonResponse({ error: { code: 'rate_limit', message: 'Model provider rate-limited (429).' } }, 429);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);

    // Network failure on connect surfaces clear error
    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-token-connect-error')).toHaveTextContent('Failed to fetch');

    // Now allow session introspection to succeed
    const originalImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/auth/session') return jsonResponse(makeApiSession());
      return originalImpl(input, init);
    });

    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-principal-banner')).toBeInTheDocument();

    // POST /executions returning 429 must not retry and must preserve connected session
    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'Test 429 create');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/Daily token quota exceeded \(429\)/)).toBeInTheDocument();
    expect(execPosts).toBe(1);
    expect(screen.getByTestId('api-principal-banner')).toBeInTheDocument();

    // Waiting question whose /resume returns 429 must not retry and must preserve execution ID
    await user.type(screen.getByTestId('chat-prompt-textarea'), 'Test 429 resume');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    sseWait.send('execution', { id: 'exec-201', conversation_id: 'conv-201' });
    sseWait.send('question', {
      kind: 'clarification',
      question: 'Choose ruleset',
      options: ['International'],
      actions: ['clarify'],
    });
    sseWait.close();

    const radio = await screen.findByRole('radio', { name: 'International' });
    await user.click(radio);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Model provider rate-limited \(429\)/)).toBeInTheDocument();
    expect(resumePosts).toBe(1);
    expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('Exec: exec-201');

    // Switch usage mock to unverified_usage and trigger usage refresh via New conversation -> or reconnect
    simulateUnverified = true;
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.type(screen.getByTestId('api-token-input'), TOKEN_B);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByText(/Token usage for this principal could not be verified/)).toBeInTheDocument();
    expect(screen.getByTestId('chat-prompt-textarea')).toBeDisabled();
  });

  it('switches Cloudscape appearance across Light, Dark, and Dark blue in the top bar', async () => {
    const user = userEvent.setup();
    render(<ApiTokenShell />);

    const trigger = screen.getByRole('button', { name: /Appearance:/ });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Dark blue' }));
    expect(document.body.dataset.colorTheme).toBe('dark-blue');

    await user.click(screen.getByRole('button', { name: /Appearance:/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
    expect(document.body.dataset.colorTheme).toBe('dark');

    await user.click(screen.getByRole('button', { name: /Appearance:/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Light' }));
    expect(document.body.dataset.colorTheme).toBe('light');
  });

  it('guards against slow stale session introspection response after local disconnect', async () => {
    let resolveSession!: (val: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => { resolveSession = resolve; }),
    );

    const user = userEvent.setup();
    const { unmount } = render(<ApiTokenShell />);
    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    // Unmount simulates tearing down / aborting before slow introspection returns
    unmount();
    resolveSession(jsonResponse(makeApiSession()));
    await Promise.resolve();
    expect(within(document.body).queryByTestId('api-principal-banner')).not.toBeInTheDocument();
  });

  it('keeps replacement principal B connected when a delayed request from disconnected principal A returns 401 and still disconnects on current 401', async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }

    const aExecDeferred = deferred<Response>();
    let aExecSignal: AbortSignal | undefined;
    let aExecStarted = false;
    const authLeakCalls: string[] = [];
    const refreshSpy = vi.fn(async () => 'human-jwt-must-not-run');
    registerTokenRefresher(refreshSpy);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization') || '';
      if (url.includes('/api/auth/refresh') || url.includes('/api/auth/logout')) {
        authLeakCalls.push(url);
      }
      if (url === '/api/auth/session') {
        if (auth === `Bearer ${TOKEN_A}`) {
          return jsonResponse(makeApiSession({ id: 'principal-a', username: 'principal-a' }));
        }
        return jsonResponse(makeApiSession({ id: 'principal-b', username: 'principal-b' }));
      }
      if (url === '/api/chat/usage') {
        return jsonResponse({
          daily_token_limit: 5000,
          total_tokens: 100,
          remaining_tokens: 4900,
          unverified_usage: false,
          in_progress: false,
        });
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT', provider: 'openai', api_id: 'gpt-6', enabled: true }]);
      }
      if (url === '/api/chat/executions' && init?.method === 'POST') {
        if (auth === `Bearer ${TOKEN_A}`) {
          aExecStarted = true;
          aExecSignal = init?.signal ?? undefined;
          return aExecDeferred.promise;
        }
        return jsonResponse({ detail: 'Principal B revoked' }, 401);
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);

    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('principal-a');

    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'Delayed A request');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(aExecStarted).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(aExecSignal?.aborted).toBe(true);

    await user.type(await screen.findByTestId('api-token-input'), TOKEN_B);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('principal-b');

    // Delayed 401 from disconnected principal A must be ignored even after A is gone and B is active
    aExecDeferred.resolve(jsonResponse({ detail: 'Principal A expired' }, 401));
    await waitFor(() => {
      expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('principal-b');
    });
    expect(screen.queryByTestId('api-token-connect-error')).not.toBeInTheDocument();

    // Genuine 401 for current principal B still disconnects without JWT refresh or cookie fallback
    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'Current B 401');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    const errBanner = await screen.findByTestId('api-token-connect-error');
    expect(errBanner).toHaveTextContent('Disconnected because the API token was rejected (401)');
    expect(errBanner).toHaveTextContent('Principal B revoked');
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(authLeakCalls).toEqual([]);
  });

  it('ignores stale 401 after disconnecting and reconnecting with the same API token', async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }

    const firstConnDeferred = deferred<Response>();
    let execCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/auth/session') {
        return jsonResponse(makeApiSession({ id: 'principal-a', username: 'principal-a' }));
      }
      if (url === '/api/chat/usage') {
        return jsonResponse({
          daily_token_limit: 5000,
          total_tokens: 0,
          remaining_tokens: 5000,
          unverified_usage: false,
          in_progress: false,
        });
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT', provider: 'openai', api_id: 'gpt-6', enabled: true }]);
      }
      if (url === '/api/chat/executions' && init?.method === 'POST') {
        execCount += 1;
        return firstConnDeferred.promise;
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);

    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('principal-a');

    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'First generation request');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(execCount).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.type(await screen.findByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-principal-banner')).toHaveTextContent('principal-a');

    firstConnDeferred.resolve(jsonResponse({ detail: 'Previous connection generation rejected' }, 401));
    await waitFor(() => {
      expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('principal-a');
    });
    expect(screen.queryByTestId('api-token-connect-error')).not.toBeInTheDocument();
  });

  it('ignores late execution A poll responses after execution B starts and clears polling state for B', async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }

    const poll1Deferred = deferred<Response>();
    const poll2Deferred = deferred<Response>();
    let execCount = 0;
    let poll1Started = false;
    let poll1Signal: AbortSignal | undefined;
    let poll2Started = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/auth/session') return jsonResponse(makeApiSession());
      if (url === '/api/chat/usage') {
        return jsonResponse({
          daily_token_limit: 5000,
          total_tokens: 100,
          remaining_tokens: 4900,
          unverified_usage: false,
          in_progress: false,
        });
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/models') {
        return jsonResponse([{ id: 'm-gpt', label: 'GPT', provider: 'openai', api_id: 'gpt-6', enabled: true }]);
      }
      if (url === '/api/chat/executions' && init?.method === 'POST') {
        execCount += 1;
        const sse = makeControlledSse();
        sse.send('execution', { id: `run-${execCount}`, conversation_id: 'conv-1' });
        sse.send('result', SAMPLE_RESULT);
        sse.send('done', { status: 'complete' });
        sse.close();
        return sse.response;
      }
      if (url === '/api/chat/executions/run-1') {
        poll1Started = true;
        poll1Signal = init?.signal ?? undefined;
        return poll1Deferred.promise;
      }
      if (url === '/api/chat/executions/run-2') {
        poll2Started = true;
        return poll2Deferred.promise;
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);

    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));

    await user.type(await screen.findByTestId('chat-prompt-textarea'), 'First run');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('Exec: run-1'));

    await user.click(screen.getByRole('button', { name: 'Principal and debugging' }));
    await user.click(screen.getByTestId('refresh-execution-status-button'));
    await waitFor(() => expect(poll1Started).toBe(true));

    await user.type(screen.getByTestId('chat-prompt-textarea'), 'Second run');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('Exec: run-2'));
    expect(poll1Signal?.aborted).toBe(true);

    poll1Deferred.resolve(jsonResponse({
      id: 'run-1',
      conversation_id: 'conv-1',
      status: 'failed',
      events: [],
    }));
    await waitFor(() => {
      expect(screen.getByTestId('api-principal-banner')).toHaveTextContent('Exec: run-2');
    });
    expect(screen.queryByText('failed')).not.toBeInTheDocument();

    // Refreshing run-2 is unblocked because switching executions cleared run-1's loading state
    await user.click(screen.getByTestId('refresh-execution-status-button'));
    await waitFor(() => expect(poll2Started).toBe(true));
    poll2Deferred.resolve(jsonResponse({
      id: 'run-2',
      conversation_id: 'conv-1',
      status: 'complete',
      events: [],
    }));
    expect(await screen.findByText('complete')).toBeInTheDocument();
  });

  it('evaluates concrete-resource capabilities and explicit Deny rules in the inspector drawer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization') || '';
      if (url === '/api/auth/session') {
        if (auth === `Bearer ${TOKEN_A}`) {
          return jsonResponse(makeApiSession({
            policy_statements: [
              { effect: 'Allow', actions: ['agent:models:list', 'agent:executions:create'], resources: ['*'] },
              {
                effect: 'Allow',
                actions: ['agent:models:invoke'],
                resources: ['model:review-model', 'model:blocked-model'],
              },
              {
                effect: 'Deny',
                actions: ['agent:models:invoke'],
                resources: ['model:blocked-model'],
              },
            ],
          }));
        }
        return jsonResponse(makeApiSession({
          id: 'principal-denied-models',
          username: 'no-model-bot',
          policy_statements: [
            { effect: 'Allow', actions: ['agent:*'], resources: ['*'] },
            { effect: 'Deny', actions: ['agent:models:invoke'], resources: ['model:*'] },
          ],
        }));
      }
      if (url === '/api/chat/models') {
        return jsonResponse([
          { id: 'review-model', label: 'Review Model', provider: 'openai', api_id: 'gpt-6', enabled: true },
          { id: 'blocked-model', label: 'Blocked Model', provider: 'openai', api_id: 'gpt-6.1', enabled: true },
        ]);
      }
      if (url === '/api/chat/conversations') return jsonResponse([]);
      if (url === '/api/chat/usage') {
        return jsonResponse({
          daily_token_limit: 5000,
          total_tokens: 0,
          remaining_tokens: 5000,
          unverified_usage: false,
          in_progress: false,
        });
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    render(<ApiTokenShell />);

    await user.type(screen.getByTestId('api-token-input'), TOKEN_A);
    await user.click(screen.getByTestId('api-token-connect-button'));
    expect(await screen.findByTestId('api-principal-banner')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Principal and debugging' }));
    const modelCap = await screen.findByTestId('capability-agent:models:invoke');
    await waitFor(() => {
      expect(modelCap).toHaveTextContent('Resource-scoped');
      expect(modelCap).toHaveTextContent('review-model');
      expect(modelCap).toHaveTextContent('excluded by policy: blocked-model');
    });
    expect(modelCap).not.toHaveTextContent('Denied');
    expect(screen.getByTestId('capability-agent:executions:create')).toHaveTextContent('Allowed');
    expect(screen.getByTestId('capability-agent:usage:read')).toHaveTextContent('Denied');

    // Explicit Deny on model:* overrides agent:* wildcard Allow
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.type(await screen.findByTestId('api-token-input'), TOKEN_B);
    await user.click(screen.getByTestId('api-token-connect-button'));
    await user.click(await screen.findByRole('button', { name: 'Principal and debugging' }));
    expect(await screen.findByTestId('capability-agent:models:invoke')).toHaveTextContent('Denied');
  });
});
