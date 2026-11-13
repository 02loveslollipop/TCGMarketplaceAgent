import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { InputProps } from '@cloudscape-design/components';
import {
  colorBorderDividerDefault,
  spaceScaledM,
} from '@cloudscape-design/design-tokens';
import {
  Alert,
  Box,
  Button,
  ColumnLayout,
  Container,
  CopyToClipboard,
  Dialog,
  ExpandableSection,
  FormField,
  Grid,
  Header,
  Icon,
  Input,
  KeyValuePairs,
  Link,
  LiveRegion,
  Pagination,
  PromptInput,
  SegmentedControl,
  Select,
  SpaceBetween,
  StatusIndicator,
  Steps,
  Table,
  Tabs,
  TextFilter,
} from '@cloudscape-design/components';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import Avatar from '@cloudscape-design/chat-components/avatar';
import { useCollection } from '@cloudscape-design/collection-hooks';
import { api, stream } from './client';
import { permits } from './iam';
import { ThinkingTrace } from './ThinkingTrace';
import { Markdown } from './Markdown';
import { decisionText } from './ChatActivity';
import type { ChatEntry } from './ChatActivity';
import { CardResults, BudgetResults } from './Results';
import { tokens, usd } from './Consumption';
import { settingsInputAttributes } from './inputSemantics';
import type {
  AdminExecutionDetail,
  AdminExecutionSummary,
  AgentEvent,
  Decision,
  LegalityStatus,
  Model,
  Question,
  Session,
} from './contracts';

export function statusIndicatorType(
  status: string,
): 'success' | 'loading' | 'error' | 'stopped' | 'info' {
  return status === 'complete'
    ? 'success'
    : status === 'running'
      ? 'loading'
      : status === 'failed'
        ? 'error'
        : status === 'cancelled'
          ? 'stopped'
          : 'info';
}
const sortLabel = ({
  sorted,
  descending,
}: {
  sorted: boolean;
  descending?: boolean;
}) =>
  sorted
    ? `Sorted ${descending ? 'descending' : 'ascending'}. Select to change sort order.`
    : 'Select to sort this column.';
const dateText = (value: string) => new Date(value).toLocaleString();
const humanStatus = (value: string) =>
  value === 'complete'
    ? 'Completed'
    : value === 'waiting'
      ? 'Awaiting decision'
      : value === 'running'
        ? 'Running'
        : value === 'failed'
          ? 'Failed'
          : value === 'cancelled'
            ? 'Cancelled'
            : value;

export function publicAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[Nested data omitted]';
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => publicAuditValue(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|password|secret|token|credential|api_key|access_token|refresh_token|reasoning_content|encrypted_content)$/i.test(
          key,
        )
          ? '[Redacted]'
          : publicAuditValue(item, depth + 1),
      ]),
    );
  if (typeof value === 'string')
    return value
      .replace(/tcg_api_[\w.-]+|bearer\s+[\w.-]+|sk-[\w-]+/gi, '[Redacted]')
      .slice(0, 16000);
  return value;
}

export function executionEntries(detail: AdminExecutionDetail): ChatEntry[] {
  const messages = detail.messages || [];
  const initial = messages
    .filter(
      (m) =>
        m.role === 'user' &&
        !m.content?.execution_id &&
        new Date(m.created_at) <= new Date(detail.created_at),
    )
    .at(-1);
  const source = messages.filter(
    (m) => m === initial || m.content?.execution_id === detail.id,
  );
  const entries: ChatEntry[] = [];
  const spans = new Map<string, number>();
  for (const m of source) {
    const content = m.content || {};
    let entry: ChatEntry;
    if (m.role === 'user') {
      const decision = content.decision as Decision | undefined;
      entry = {
        id: m.id,
        at: m.created_at,
        type: 'user',
        data: {
          text: content.text || (decision ? decisionText(decision) : ''),
          decision,
        },
      };
    } else if (content.type && content.data)
      entry = { ...content, id: m.id, at: m.created_at };
    else continue;
    const id =
      entry.type === 'thinking' || entry.type === 'tool'
        ? entry.data.id
        : undefined;
    if (id && spans.has(id)) {
      const index = spans.get(id)!;
      if (
        (entry.type === 'thinking' || entry.type === 'tool') &&
        entry.data.status !== 'loading'
      )
        entries[index] = entry;
    } else {
      if (id) spans.set(id, entries.length);
      entries.push(entry);
    }
  }
  if (!source.length || !source.some((m) => m.role === 'assistant'))
    for (const event of detail.events || []) {
      if (
        event.kind === 'thinking' ||
        event.kind === 'tool' ||
        event.kind === 'cards' ||
        event.kind === 'result' ||
        event.kind === 'question' ||
        event.kind === 'error'
      )
        entries.push({
          id: event.id,
          at: event.created_at,
          type: event.kind,
          data: event.payload,
        } as ChatEntry);
    }
  if (
    detail.reasoning_summary &&
    !entries.some((entry) => entry.type === 'thinking')
  )
    entries.push({
      id: 'legacy-summary',
      type: 'thinking',
      data: {
        id: 'legacy-summary',
        status: 'complete',
        source: 'approach_summary',
        summary: detail.reasoning_summary,
      },
    });
  return entries;
}

function Transcript({
  detail,
  live,
  busy,
}: {
  detail: AdminExecutionDetail | null;
  live: ChatEntry[];
  busy: boolean;
}) {
  const entries = detail ? executionEntries(detail) : live;
  const groups: { type: 'trace' | 'message'; items: ChatEntry[] }[] = [];
  for (const entry of entries) {
    if (entry.type === 'thinking' || entry.type === 'tool') {
      const last = groups.at(-1);
      if (last?.type === 'trace') last.items.push(entry);
      else groups.push({ type: 'trace', items: [entry] });
    } else if (!['progress', 'done', 'execution'].includes(entry.type))
      groups.push({ type: 'message', items: [entry] });
  }
  return (
    <div
      className="admin-transcript"
      role="region"
      aria-label="Execution transcript"
      tabIndex={0}
    >
      <SpaceBetween size="l">
        {!groups.length && (
          <Box textAlign="center" padding="xxl">
            <Box variant="h2">
              {busy
                ? 'Generating execution trace'
                : 'Inspect an execution or start a test'}
            </Box>
            <Box color="text-body-secondary">
              Requests, public reasoning summaries, tool calls and results
              appear in chronological order.
            </Box>
          </Box>
        )}
        {groups.map((group, index) =>
          group.type === 'trace' ? (
            <ThinkingTrace
              key={'trace-' + index}
              entries={group.items}
              active={busy}
              defaultExpanded
              heading={`Agent trace (${group.items.length} events)`}
            />
          ) : (
            group.items.map((entry) => {
              if (entry.type === 'user')
                return (
                  <ChatBubble
                    key={entry.id}
                    type="outgoing"
                    align="start"
                    avatar={
                      <Avatar
                        ariaLabel="Request author"
                        tooltipText="Request author"
                      />
                    }
                    ariaLabel="User request"
                  >
                    <SpaceBetween size="xs">
                      <div className="chat-message-text">{entry.data.text}</div>
                      {entry.at && (
                        <Box color="text-body-secondary" fontSize="body-s">
                          {dateText(entry.at)}
                        </Box>
                      )}
                    </SpaceBetween>
                  </ChatBubble>
                );
              if (entry.type === 'result')
                return (
                  <ChatBubble
                    key={entry.id}
                    type="incoming"
                    avatar={
                      <Avatar
                        color="gen-ai"
                        iconName="gen-ai"
                        ariaLabel="Generative AI assistant"
                        tooltipText="Generative AI assistant"
                      />
                    }
                    ariaLabel="Agent result"
                    actions={
                      <CopyToClipboard
                        variant="icon"
                        textToCopy={entry.data.recommendation || ''}
                        copyButtonAriaLabel="Copy agent result"
                        copySuccessText="Response copied"
                        copyErrorText="Unable to copy"
                      />
                    }
                  >
                    <SpaceBetween size="s">
                      <Box variant="awsui-gen-ai-label">
                        <Icon size="small" name="gen-ai" /> Generated by AI
                      </Box>
                      <Markdown
                        text={entry.data.recommendation || 'Result ready.'}
                      />
                      <ExpandableSection headerText="Budget and card details">
                        <BudgetResults result={entry.data} />
                      </ExpandableSection>
                    </SpaceBetween>
                  </ChatBubble>
                );
              if (entry.type === 'cards')
                return (
                  <Container
                    key={entry.id}
                    header={
                      <Header variant="h3">Resolved card printings</Header>
                    }
                  >
                    <ExpandableSection
                      headerText={`${entry.data.cards.reduce((sum, card) => sum + card.quantity, 0)} cards · ${entry.data.cards.length} printings`}
                    >
                      <CardResults {...entry.data} />
                    </ExpandableSection>
                  </Container>
                );
              if (entry.type === 'question')
                return (
                  <Alert
                    key={entry.id}
                    type="info"
                    header={
                      entry.data.kind === 'deck_approval'
                        ? 'Deck review'
                        : 'Decision requested'
                    }
                  >
                    <Markdown text={entry.data.question} />
                  </Alert>
                );
              if (entry.type === 'error')
                return (
                  <Alert key={entry.id} type="error">
                    {entry.data.message}
                  </Alert>
                );
              return null;
            })
          ),
        )}
        {busy && (
          <StatusIndicator type="loading">
            Generating execution trace
          </StatusIndicator>
        )}
      </SpaceBetween>
    </div>
  );
}

export function AdminActivity({
  token,
  session,
}: {
  token: string;
  session?: Session;
}) {
  const [view, setView] = useState('activity'),
    [rows, setRows] = useState<AdminExecutionSummary[]>([]),
    [models, setModels] = useState<Model[]>([]),
    [detail, setDetail] = useState<AdminExecutionDetail | null>(null),
    [selectedId, setSelectedId] = useState(''),
    [loadingId, setLoadingId] = useState(''),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [legality, setLegality] = useState<LegalityStatus | null>(null),
    [legalityError, setLegalityError] = useState(''),
    [syncing, setSyncing] = useState(false);
  const [model, setModel] = useState(''),
    [prompt, setPrompt] = useState(''),
    [decision, setDecision] = useState(''),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState<ChatEntry[]>([]),
    [question, setQuestion] = useState<Question | null>(null),
    [announcement, setAnnouncement] = useState(''),
    [tab, setTab] = useState('transcript');
  const decisionField = useRef<InputProps.Ref>(null);
  const [decisionError, setDecisionError] = useState('');
  const requestId = useRef(0),
    controller = useRef<AbortController | null>(null),
    streamExecution = useRef(''),
    streamConversation = useRef('');
  const currentToken = useRef(token);
  currentToken.current = token;
  async function loadRows() {
    setLoading(true);
    try {
      const data = await api<AdminExecutionSummary[]>(
        '/api/admin/activity?limit=200',
        token,
      );
      if (currentToken.current === token) setRows(data);
    } catch (error) {
      if (currentToken.current === token) setError((error as Error).message);
    } finally {
      if (currentToken.current === token) setLoading(false);
    }
  }
  async function loadLegality() {
    if (!permits(session, 'admin:legality:read')) return;
    try {
      setLegality(await api('/api/admin/legality/status', token));
      setLegalityError('');
    } catch (error) {
      setLegalityError((error as Error).message);
    }
  }
  useEffect(() => {
    void loadRows();
    void loadLegality();
    void api<Model[]>('/api/chat/models', token)
      .then((data) => {
        if (currentToken.current !== token) return;
        if (Array.isArray(data)) {
          setModels(data);
          setModel((old) => old || data[0]?.id || '');
        }
      })
      .catch(() => {});
    return () => {
      requestId.current++;
      controller.current?.abort();
    };
  }, [token]);
  async function open(id: string, showWorkspace = true, clearError = true) {
    const version = ++requestId.current;
    setLoadingId(id);
    setSelectedId(id);
    if (clearError) setError('');
    if (id !== detail?.id) {
      setDetail(null);
      setQuestion(null);
      setLive([]);
    }
    if (showWorkspace) setView('playground');
    try {
      const value = await api<AdminExecutionDetail>(
        '/api/admin/activity/' + id,
        token,
      );
      if (version === requestId.current && currentToken.current === token) {
        setDetail(value);
        setLive([]);
        streamExecution.current = value.id;
        streamConversation.current = value.conversation_id;
        setModel(value.model_id);
        setQuestion(
          value.status === 'waiting'
            ? (value.checkpoint as unknown as Question)
            : null,
        );
        setAnnouncement(`Execution ${id} loaded.`);
      }
    } catch (error) {
      if (version === requestId.current) setError((error as Error).message);
    } finally {
      if (version === requestId.current) setLoadingId('');
    }
  }
  useEffect(() => {
    if (!detail || detail.status !== 'running' || busy) return;
    const id = detail.id;
    const timer = setInterval(() => {
      void open(id, false);
    }, 10000);
    return () => clearInterval(timer);
  }, [detail?.id, detail?.status, busy, token]);
  function newSession() {
    requestId.current++;
    setDetail(null);
    setSelectedId('');
    setLoadingId('');
    setLive([]);
    setQuestion(null);
    setPrompt('');
    setDecision('');
    streamExecution.current = '';
    streamConversation.current = '';
    setView('playground');
    setError('');
    setModel(models[0]?.id || '');
  }
  const own = !detail || !session || detail.user_id === session.id;
  const canRun =
    own &&
    !loadingId &&
    (!selectedId || detail?.id === selectedId) &&
    permits(session, 'agent:executions:create') &&
    models.some((item) => item.id === model);
  const pending = detail?.status === 'waiting' ? question : null;
  async function execute(path: string, body: unknown, userText: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setLive((old) => [
      ...old,
      { id: crypto.randomUUID(), type: 'user', data: { text: userText } },
    ]);
    setDetail(null);
    controller.current = new AbortController();
    const capturedToken = token;
    try {
      await stream(
        path,
        token,
        body,
        (event) => {
          if (currentToken.current !== capturedToken) return;
          if (event.type === 'execution') {
            streamExecution.current = event.data.id;
            streamConversation.current = event.data.conversation_id;
            setSelectedId(event.data.id);
          }
          if (event.type === 'question') setQuestion(event.data);
          if (event.type === 'error') setError(event.data.message);
          setLive((old) => {
            const entry = { ...event, id: crypto.randomUUID() } as ChatEntry;
            if (event.type === 'thinking' || event.type === 'tool') {
              const index = old.findIndex(
                (item) =>
                  (item.type === 'thinking' || item.type === 'tool') &&
                  item.type === event.type &&
                  item.data.id === event.data.id,
              );
              if (index >= 0)
                return old.map((item, i) =>
                  i === index ? { ...entry, id: item.id } : item,
                );
            }
            return [...old, entry];
          });
        },
        controller.current.signal,
      );
      await loadRows();
      if (streamExecution.current)
        await open(streamExecution.current, false, false);
    } catch (error) {
      setError((error as Error).message);
      if (streamExecution.current)
        await open(streamExecution.current, false, false);
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }
  async function submit() {
    if (!prompt.trim()) {
      setError('Enter a test request.');
      return;
    }
    if (!canRun || busy) return;
    const text = prompt;
    setPrompt('');
    setQuestion(null);
    await execute(
      '/api/chat/executions',
      {
        text,
        model_id: model,
        ...(streamConversation.current
          ? { conversation_id: streamConversation.current }
          : {}),
      },
      text,
    );
  }
  async function decide(action: Decision['action'], text = decision) {
    if (!detail || !own || !permits(session, 'agent:executions:resume')) return;
    if (
      ['clarify', 'revise_deck', 'substitute'].includes(action) &&
      !text.trim()
    ) {
      setDecisionError('Enter a response before continuing.');
      decisionField.current?.focus();
      return;
    }
    setDecisionError('');
    const body: Decision = {
      action,
      ...(['approve_deck', 'keep_missing'].includes(action)
        ? { approved: true }
        : {}),
      text,
      ...(action === 'clarify' ? { selected_option: text } : {}),
    };
    setQuestion(null);
    setDecision('');
    await execute(
      '/api/chat/executions/' + detail.id + '/resume',
      body,
      decisionText(body),
    );
  }
  const c = useCollection(rows, {
    filtering: {
      fields: ['id', 'conversation_title', 'model_id', 'status', 'user_id'],
      empty: <Box padding="l">No executions recorded.</Box>,
      noMatch: (
        <Box padding="l">
          No matching executions. Clear the filter to see all loaded activity.
        </Box>
      ),
    },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: 'created_at' },
        isDescending: true,
      },
    },
    pagination: { pageSize: 10 },
  });
  const usage = detail?.usage;
  const eventCount = detail?.events.length || live.length;
  return (
    <SpaceBetween size="l">
      <LiveRegion hidden>{announcement}</LiveRegion>
      <Header
        variant="h1"
        description="Inspect requests, public reasoning summaries, tool calls and usage. Start an isolated test with your own account."
        actions={
          <SegmentedControl
            selectedId={view}
            onChange={({ detail }) => {
              if (!busy) setView(detail.selectedId);
            }}
            options={[
              { id: 'activity', text: 'Execution log', disabled: busy },
              { id: 'playground', text: 'Playground', disabled: busy },
            ]}
          />
        }
      >
        Agent activity
      </Header>
      {error && (
        <Alert
          type="error"
          header="Activity request failed"
          dismissible
          onDismiss={() => setError('')}
        >
          {error}
        </Alert>
      )}
      {view === 'activity' ? (
        <Table
          {...c.collectionProps}
          items={c.items}
          trackBy="id"
          ariaLabels={{ tableLabel: 'Agent execution activity' }}
          loading={loading}
          loadingText="Loading executions"
          header={
            <Header
              variant="h2"
              counter={`(${rows.length})`}
              description="The latest 200 executions. Filtering and sorting apply to this loaded collection."
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={newSession}>New test session</Button>
                  <Button iconName="refresh" onClick={() => void loadRows()}>
                    Refresh activity
                  </Button>
                </SpaceBetween>
              }
            >
              Executions
            </Header>
          }
          filter={
            <TextFilter
              {...c.filterProps}
              filteringAriaLabel="Find executions"
              filteringPlaceholder="Find a title, principal, model, status or execution ID"
              countText={`${c.filteredItemsCount} matches`}
            />
          }
          pagination={<Pagination {...c.paginationProps} />}
          columnDefinitions={[
            {
              id: 'title',
              header: 'Conversation',
              isRowHeader: true,
              ariaLabel: sortLabel,
              sortingField: 'conversation_title',
              cell: (row) => (
                <Link
                  onFollow={(event) => {
                    event.preventDefault();
                    void open(row.id);
                  }}
                >
                  {row.conversation_title || 'Untitled conversation'}
                </Link>
              ),
            },
            {
              id: 'id',
              header: 'Execution',
              cell: (row) => <Box variant="awsui-inline-code">{row.id}</Box>,
            },
            {
              id: 'model',
              header: 'Model',
              ariaLabel: sortLabel,
              sortingField: 'model_id',
              cell: (row) => row.model_id,
            },
            {
              id: 'status',
              header: 'Status',
              ariaLabel: sortLabel,
              sortingField: 'status',
              cell: (row) => (
                <StatusIndicator type={statusIndicatorType(row.status)}>
                  {humanStatus(row.status)}
                </StatusIndicator>
              ),
            },
            {
              id: 'tokens',
              header: 'Recorded tokens',
              ariaLabel: sortLabel,
              sortingComparator: (a, b) =>
                (a.usage?.total_tokens || 0) - (b.usage?.total_tokens || 0),
              cell: (row) =>
                row.usage?.recorded
                  ? tokens(row.usage.total_tokens)
                  : 'Not recorded',
            },
            {
              id: 'time',
              header: 'Started',
              ariaLabel: sortLabel,
              sortingField: 'created_at',
              cell: (row) => dateText(row.created_at),
            },
            {
              id: 'open',
              header: 'Actions',
              cell: (row) => (
                <Button
                  variant="inline-link"
                  loading={loadingId === row.id}
                  ariaLabel={`View trace for ${row.conversation_title}`}
                  onClick={() => void open(row.id)}
                >
                  View trace
                </Button>
              ),
            },
          ]}
        />
      ) : (
        <Container
          disableContentPaddings
          header={
            <Header
              variant="h2"
              description={
                selectedId
                  ? `Execution ${selectedId}`
                  : 'Your test requests use your account role, model access and daily quota.'
              }
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button disabled={busy} onClick={newSession}>
                    New session
                  </Button>
                  <Button
                    iconName="refresh"
                    disabled={!selectedId || busy}
                    onClick={() => void open(selectedId)}
                  >
                    Refresh execution
                  </Button>
                </SpaceBetween>
              }
            >
              Execution workspace
            </Header>
          }
        >
          <Box padding="m">
            <Grid
              gridDefinition={[
                { colspan: { default: 12, s: 8 } },
                { colspan: { default: 12, s: 4 } },
              ]}
            >
              <FormField label="Execution">
                <Select
                  ariaLabel="Execution selector"
                  filteringType="auto"
                  disabled={busy}
                  selectedOption={
                    rows.find((row) => row.id === selectedId)
                      ? {
                          value: selectedId,
                          label:
                            rows.find((row) => row.id === selectedId)!
                              .conversation_title +
                            ' · ' +
                            selectedId,
                        }
                      : null
                  }
                  placeholder="Choose an execution or start a new session"
                  options={rows.map((row) => ({
                    value: row.id,
                    label: row.conversation_title + ' · ' + row.id,
                    description: `${row.model_id} · ${humanStatus(row.status)}`,
                  }))}
                  onChange={({ detail }) =>
                    void open(detail.selectedOption.value!)
                  }
                />
              </FormField>
              <FormField label="Model">
                <Select
                  selectedOption={
                    model
                      ? {
                          value: model,
                          label:
                            models.find((row) => row.id === model)?.label ||
                            model,
                        }
                      : null
                  }
                  options={models.map((row) => ({
                    value: row.id,
                    label: row.label,
                  }))}
                  disabled={busy || !own}
                  placeholder="Choose a permitted model"
                  onChange={({ detail }) =>
                    setModel(detail.selectedOption.value!)
                  }
                />
              </FormField>
            </Grid>
          </Box>
          <div
            className="admin-execution-workspace"
            style={
              {
                '--observability-divider': colorBorderDividerDefault,
                '--observability-space': spaceScaledM,
              } as CSSProperties
            }
          >
            <div className="admin-execution-main">
              <Box padding="m">
                <SpaceBetween direction="horizontal" size="m">
                  <Box>
                    Input:{' '}
                    {usage?.recorded
                      ? tokens(usage.input_tokens)
                      : 'Not recorded'}
                  </Box>
                  <Box>
                    Output:{' '}
                    {usage?.recorded
                      ? tokens(usage.output_tokens)
                      : 'Not recorded'}
                  </Box>
                  <Box>
                    Total:{' '}
                    {usage?.recorded
                      ? tokens(usage.total_tokens)
                      : 'Not recorded'}
                  </Box>
                  <Box>
                    Model call time:{' '}
                    {usage?.model_duration_ms != null
                      ? `${(usage.model_duration_ms / 1000).toFixed(1)} s`
                      : 'Not recorded'}
                  </Box>
                </SpaceBetween>
              </Box>
              <div className="admin-execution-tabs">
                {loadingId ? (
                  <Box padding="l">
                    <StatusIndicator type="loading">
                      Loading execution
                    </StatusIndicator>
                  </Box>
                ) : (
                  <Tabs
                    fitHeight
                    activeTabId={tab}
                    onChange={({ detail }) => setTab(detail.activeTabId)}
                    tabs={[
                      {
                        id: 'transcript',
                        label: 'Transcript and trace',
                        content: (
                          <Transcript detail={detail} live={live} busy={busy} />
                        ),
                      },
                      {
                        id: 'events',
                        label: `Event timeline (${eventCount})`,
                        content: (
                          <div className="admin-transcript">
                            <Steps
                              ariaLabel="Execution event timeline"
                              steps={(detail?.events || []).map((event) => ({
                                status:
                                  event.payload?.status === 'error' ||
                                  event.kind === 'error'
                                    ? ('error' as const)
                                    : ('info' as const),
                                header: (
                                  <SpaceBetween direction="horizontal" size="s">
                                    <Box>{event.kind}</Box>
                                    <Box
                                      color="text-body-secondary"
                                      fontSize="body-s"
                                    >
                                      {dateText(event.created_at)}
                                    </Box>
                                  </SpaceBetween>
                                ),
                                details: (
                                  <ExpandableSection
                                    variant="inline"
                                    headerText="Event details"
                                  >
                                    <Box variant="pre">
                                      {JSON.stringify(
                                        publicAuditValue(event.payload),
                                        null,
                                        2,
                                      )}
                                    </Box>
                                  </ExpandableSection>
                                ),
                              }))}
                            />
                          </div>
                        ),
                      },
                      {
                        id: 'audit',
                        label: 'Audit records',
                        content: (
                          <div className="admin-transcript">
                            <SpaceBetween size="m">
                              {(detail?.logs || []).map((log) => (
                                <Container
                                  key={log.id}
                                  header={
                                    <Header variant="h3">
                                      {log.action.replaceAll('_', ' ')}
                                    </Header>
                                  }
                                >
                                  <Box>{dateText(log.created_at)}</Box>
                                  <ExpandableSection headerText="Audit details">
                                    <Box variant="pre">
                                      {JSON.stringify(
                                        publicAuditValue(log.details),
                                        null,
                                        2,
                                      )}
                                    </Box>
                                  </ExpandableSection>
                                </Container>
                              ))}
                            </SpaceBetween>
                          </div>
                        ),
                      },
                    ]}
                    ariaLabel="Execution details"
                  />
                )}
              </div>
              <Box padding="m">
                <SpaceBetween size="m">
                  {!own && (
                    <Alert type="info">
                      Read-only execution from another principal. Start a new
                      session to run a test with your own account.
                    </Alert>
                  )}
                  {pending && own && (
                    <Dialog
                      onDismiss={() => void decide('cancel')}
                      i18nStrings={{
                        dismissAriaLabel: 'Cancel this execution',
                      }}
                      header={
                        pending.kind === 'deck_approval'
                          ? 'Approve the resolved deck'
                          : 'Execution needs a decision'
                      }
                      footer={
                        <SpaceBetween direction="horizontal" size="xs">
                          <Button
                            formAction="none"
                            disabled={busy}
                            onClick={() => void decide('cancel')}
                          >
                            Cancel execution
                          </Button>
                          {pending.kind === 'deck_approval' ? (
                            <>
                              <Button
                                disabled={busy}
                                onClick={() => void decide('revise_deck')}
                              >
                                Request changes
                              </Button>
                              <Button
                                variant="primary"
                                loading={busy}
                                onClick={() => void decide('approve_deck')}
                              >
                                Approve and price this deck
                              </Button>
                            </>
                          ) : pending.kind === 'missing_cards' ? (
                            <>
                              <Button
                                disabled={busy}
                                onClick={() => void decide('substitute')}
                              >
                                Research alternatives
                              </Button>
                              <Button
                                variant="primary"
                                loading={busy}
                                onClick={() => void decide('keep_missing')}
                              >
                                Keep listed shortfalls
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="primary"
                              loading={busy}
                              onClick={() => void decide('clarify')}
                            >
                              Submit response
                            </Button>
                          )}
                        </SpaceBetween>
                      }
                    >
                      <SpaceBetween size="s">
                        <Box>{pending.question}</Box>
                        {pending.options?.map((option) => (
                          <Button
                            key={option}
                            disabled={busy}
                            onClick={() => setDecision(option)}
                          >
                            {option}
                          </Button>
                        ))}
                        <FormField
                          errorText={decisionError || undefined}
                          label={
                            pending.kind === 'deck_approval' ? (
                              <span>
                                Requested changes <i>- optional</i>
                              </span>
                            ) : (
                              'Response'
                            )
                          }
                        >
                          <Input
                            ref={decisionField}
                            name="execution-decision-text"
                            nativeInputAttributes={settingsInputAttributes}
                            autoComplete="off"
                            value={decision}
                            onChange={({ detail }) => {
                              setDecision(detail.value);
                              setDecisionError('');
                            }}
                          />
                        </FormField>
                      </SpaceBetween>
                    </Dialog>
                  )}
                  {!pending && (
                    <PromptInput
                      ariaLabel="Test request"
                      value={prompt}
                      onChange={({ detail }) => setPrompt(detail.value)}
                      onAction={() => void submit()}
                      placeholder={
                        own
                          ? 'Write a test request'
                          : 'Start your own session to submit a request'
                      }
                      readOnly={busy || !canRun}
                      minRows={1}
                      maxRows={4}
                      i18nStrings={{
                        actionButtonAriaLabel: 'Submit test request',
                      }}
                      customPrimaryAction={
                        busy ? (
                          <Button
                            variant="icon"
                            iconName="stop-circle"
                            ariaLabel="Stop test execution"
                            onClick={() => controller.current?.abort()}
                          />
                        ) : undefined
                      }
                    />
                  )}
                  <Box color="text-body-secondary" fontSize="body-s">
                    Public summaries and tool metadata are shown. Raw private
                    reasoning and credentials are excluded.
                  </Box>
                </SpaceBetween>
              </Box>
            </div>
            <aside
              className="admin-execution-details"
              aria-label="Execution context"
            >
              <Box padding="m">
                <SpaceBetween size="l">
                  <Header variant="h3">Execution details</Header>
                  {detail ? (
                    <>
                      <StatusIndicator
                        type={statusIndicatorType(detail.status)}
                      >
                        {humanStatus(detail.status)}
                      </StatusIndicator>
                      <KeyValuePairs
                        columns={1}
                        items={[
                          {
                            label: 'Execution ID',
                            value: (
                              <CopyToClipboard
                                textToCopy={detail.id}
                                variant="inline"
                                copyButtonAriaLabel="Copy execution ID"
                                copySuccessText="Execution ID copied"
                                copyErrorText="Unable to copy"
                              />
                            ),
                          },
                          {
                            label: 'Conversation',
                            value: detail.conversation_title,
                          },
                          { label: 'Principal ID', value: detail.user_id },
                          { label: 'Model', value: detail.model_id },
                          {
                            label: 'Started',
                            value: dateText(detail.created_at),
                          },
                          {
                            label: 'Priced usage estimate',
                            value: usd(usage?.estimated_cost_usd),
                          },
                          {
                            label: 'Unpriced tokens',
                            value: usage?.recorded
                              ? tokens(usage.unpriced_tokens)
                              : 'Not recorded',
                          },
                        ]}
                      />
                      <ExpandableSection
                        data-testid="run-selector"
                        defaultExpanded
                        headerText="Session executions"
                      >
                        <SpaceBetween size="s">
                          {detail.thread_executions?.map((row) => (
                            <Button
                              key={row.id}
                              variant="inline-link"
                              disabled={busy}
                              onClick={() => void open(row.id)}
                            >
                              {humanStatus(row.status)} · {row.id}
                            </Button>
                          ))}
                        </SpaceBetween>
                      </ExpandableSection>
                    </>
                  ) : (
                    <Box color="text-body-secondary">
                      Select an execution to inspect its context. A new test
                      uses your current account permissions.
                    </Box>
                  )}
                </SpaceBetween>
              </Box>
            </aside>
          </div>
        </Container>
      )}
      {permits(session, 'admin:legality:read') && (
        <ExpandableSection headerText="Legality catalog">
          <SpaceBetween size="m">
            {legalityError && <Alert type="error">{legalityError}</Alert>}
            {legality && (
              <KeyValuePairs
                columns={4}
                items={[
                  { label: 'Status', value: legality.status },
                  {
                    label: 'Last refreshed',
                    value: legality.last_refreshed_at
                      ? dateText(legality.last_refreshed_at)
                      : 'Never',
                  },
                  { label: 'Sets', value: legality.sets_count },
                  { label: 'Banned cards', value: legality.banned_count },
                ]}
              />
            )}
            <Button
              iconName="refresh"
              loading={syncing}
              disabled={!permits(session, 'admin:legality:refresh')}
              onClick={() => {
                setSyncing(true);
                void api<LegalityStatus>('/api/admin/legality/refresh', token, {
                  method: 'POST',
                })
                  .then(setLegality)
                  .catch((error) => setLegalityError(error.message))
                  .finally(() => setSyncing(false));
              }}
            >
              Refresh legality catalog
            </Button>
          </SpaceBetween>
        </ExpandableSection>
      )}
    </SpaceBetween>
  );
}
