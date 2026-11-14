import {useCallback,useEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {Alert,Badge,Box,Button,Container,ContentLayout,Flashbar,Form,FormField,Header,Input,KeyValuePairs,SideNavigation,SpaceBetween,SplitPanel,StatusIndicator,TopNavigation} from '@cloudscape-design/components';
import AppLayoutToolbar from '@cloudscape-design/components/app-layout-toolbar';
import type {AppLayoutProps,InputProps} from '@cloudscape-design/components';
import {colorBackgroundContainerContent,colorBackgroundHomeHeader,colorBorderDividerDefault,colorTextHomeHeaderDefault} from '@cloudscape-design/design-tokens';
import {ApiError,ClientTransportContext,api,configuredApiDestinations} from './client';
import type {DailyUsage,ExecutionStatusSnapshot,Model,Session} from './contracts';
import {evaluateAgentCapability,permits,roleLabel} from './iam';
import {Chat,type ExecutionDebugInfo} from './Chat';
import {Preferences} from './Preferences';
import {ArtifactContent,artifactTitle,type ChatArtifact} from './ChatArtifacts';
import {appearanceOptions,setAppearance,useAppearance,type Appearance} from './appearance';
import {settingsInputAttributes} from './inputSemantics';
import './login.css';
import './workspace.css';
import './api-test.css';

type ApiPage = 'chat' | 'preferences';

const AGENT_CAPABILITIES: readonly { action: string; description: string }[] = [
  { action: 'agent:models:list', description: 'List enabled models' },
  { action: 'agent:models:invoke', description: 'Invoke permitted models' },
  { action: 'agent:usage:read', description: 'Read principal daily usage' },
  { action: 'agent:conversations:read', description: 'Read saved conversations' },
  { action: 'agent:conversations:write', description: 'Rename conversations' },
  { action: 'agent:conversations:delete', description: 'Delete conversations' },
  { action: 'agent:executions:create', description: 'Start new executions' },
  { action: 'agent:executions:read', description: 'Inspect execution state and results' },
  { action: 'agent:executions:resume', description: 'Answer waiting decisions' },
  { action: 'agent:preferences:read', description: 'Read principal preferences and currencies' },
  { action: 'agent:preferences:write', description: 'Save principal preferences' },
];

const EXECUTION_STATUS_LABELS: Record<ExecutionDebugInfo['status'], { label: string; type: 'stopped' | 'in-progress' | 'warning' | 'error' | 'success' }> = {
  idle: { label: 'Idle', type: 'stopped' },
  streaming: { label: 'Streaming SSE', type: 'in-progress' },
  waiting: { label: 'Waiting for decision', type: 'warning' },
  cancelled: { label: 'Cancelled', type: 'stopped' },
  stopped_local: { label: 'Stopped in browser', type: 'stopped' },
  incomplete: { label: 'Stream ended early', type: 'warning' },
  error: { label: 'Execution failed', type: 'error' },
  complete: { label: 'Complete', type: 'success' },
};

function validateApiTokenInput(raw: string): { valid: true; token: string } | { valid: false; message: string } {
  if (!raw.trim()) {
    return { valid: false, message: 'Enter an API token before connecting.' };
  }
  if (/\s/.test(raw)) {
    return { valid: false, message: 'API token cannot contain spaces or line breaks.' };
  }
  if (/[^\x21-\x7E]/.test(raw)) {
    return { valid: false, message: 'API token contains unsupported characters.' };
  }
  return { valid: true, token: raw };
}

function pageFromHash(): ApiPage {
  return window.location.hash === '#preferences' ? 'preferences' : 'chat';
}

export function ApiTokenShell() {
  const appearance = useAppearance();
  const destinations = useMemo(() => configuredApiDestinations(), []);

  const [tokenInput, setTokenInput] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [disconnectNotice, setDisconnectNotice] = useState('');

  const [connectedToken, setConnectedToken] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [connectionId, setConnectionId] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  const [page, setPage] = useState<ApiPage>(pageFromHash);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [chatNavigation, setChatNavigation] = useState<HTMLDivElement | null>(null);
  const [artifact, setArtifact] = useState<ChatArtifact | null>(null);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [panelSize, setPanelSize] = useState(580);
  const [panelPreferences, setPanelPreferences] = useState<AppLayoutProps.SplitPanelPreferences>({ position: 'side' });

  const [usageSnapshot, setUsageSnapshot] = useState<DailyUsage | null>(null);
  const [usageError, setUsageError] = useState('');
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [executionDebug, setExecutionDebug] = useState<ExecutionDebugInfo>({ executionId: '', status: 'idle' });
  const [executionPoll, setExecutionPoll] = useState<ExecutionStatusSnapshot | null>(null);
  const [executionPolling, setExecutionPolling] = useState(false);
  const [executionPollError, setExecutionPollError] = useState('');

  const tokenInputRef = useRef<InputProps.Ref>(null);
  const connectionEpochRef = useRef(0);
  const activeConnectionEpochRef = useRef(0);
  const activeTokenRef = useRef('');
  const activeExecutionIdRef = useRef('');
  const pollEpochRef = useRef(0);
  const introspectAbortRef = useRef<AbortController | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.body.classList.add('awsui-visual-refresh');
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      connectionEpochRef.current += 1;
      pollEpochRef.current += 1;
      activeConnectionEpochRef.current = 0;
      activeTokenRef.current = '';
      activeExecutionIdRef.current = '';
      introspectAbortRef.current?.abort();
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
    };
  }, []);

  const resetWorkspaceUi = useCallback(() => {
    setTokenInput('');
    setTokenError('');
    setArtifact(null);
    setArtifactOpen(false);
    setUsageSnapshot(null);
    setUsageError('');
    setAvailableModels([]);
    setSelectedModelId('');
    setExecutionDebug({ executionId: '', status: 'idle' });
    setExecutionPoll(null);
    setExecutionPollError('');
    setExecutionPolling(false);
    setPage('chat');
    if (window.location.hash && window.location.hash !== '#chat') {
      window.location.hash = 'chat';
    }
  }, []);

  const resetWorkspaceState = useCallback(() => {
    pollEpochRef.current += 1;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    activeConnectionEpochRef.current = 0;
    activeTokenRef.current = '';
    activeExecutionIdRef.current = '';
    setConnectionEpoch(0);
    setConnectedToken('');
    setSession(null);
    resetWorkspaceUi();
    setConnectionId((value) => value + 1);
  }, [resetWorkspaceUi]);

  const disconnect = useCallback((noticeMessage: string, isErrorBanner = false) => {
    connectionEpochRef.current += 1;
    introspectAbortRef.current?.abort();
    resetWorkspaceState();
    if (isErrorBanner) {
      setConnectError(noticeMessage);
      setDisconnectNotice('');
    } else {
      setConnectError('');
      setDisconnectNotice(noticeMessage);
    }
  }, [resetWorkspaceState]);

  const disconnectForEpoch = useCallback(
    (epoch: number, err: ApiError) => {
      if (
        !epoch ||
        epoch !== connectionEpochRef.current ||
        epoch !== activeConnectionEpochRef.current ||
        !activeTokenRef.current
      ) {
        return;
      }
      const detail = err.message ? ` Server response: ${err.message}` : '';
      disconnect(
        `Disconnected because the API token was rejected (401). Confirm the token is active and has not expired or been revoked.${detail}`,
        true,
      );
    },
    [disconnect],
  );

  const handleUnauthorized = useMemo(
    () => (err: ApiError) => {
      disconnectForEpoch(connectionEpoch, err);
    },
    [connectionEpoch, disconnectForEpoch],
  );

  const handleUsageChange = useCallback((nextUsage: DailyUsage | null, nextError: string) => {
    setUsageSnapshot(nextUsage);
    setUsageError(nextError);
  }, []);

  const handleModelsChange = useCallback((models: Model[], nextSelectedModelId: string) => {
    setAvailableModels(models);
    setSelectedModelId(nextSelectedModelId);
  }, []);

  const handleExecutionStateChange = useCallback((info: ExecutionDebugInfo) => {
    const executionChanged = info.executionId !== activeExecutionIdRef.current;
    if (executionChanged) {
      activeExecutionIdRef.current = info.executionId;
      pollEpochRef.current += 1;
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      setExecutionPolling(false);
      setExecutionPoll(null);
      setExecutionPollError('');
    } else if (info.status === 'streaming') {
      setExecutionPoll(null);
      setExecutionPollError('');
    }
    setExecutionDebug(info);
  }, []);

  async function connect() {
    if (connecting) return;
    const validation = validateApiTokenInput(tokenInput);
    if (!validation.valid) {
      setTokenError(validation.message);
      tokenInputRef.current?.focus();
      return;
    }

    const epoch = ++connectionEpochRef.current;
    introspectAbortRef.current?.abort();
    const abort = new AbortController();
    introspectAbortRef.current = abort;

    setTokenError('');
    setConnectError('');
    setDisconnectNotice('');
    setConnecting(true);

    try {
      const result = await api<Session>(
        '/api/auth/session',
        validation.token,
        { method: 'GET', signal: abort.signal },
        { authMode: 'api-token' },
      );

      if (epoch !== connectionEpochRef.current || abort.signal.aborted) return;

      if (result.principal_type !== 'api') {
        setConnectError(
          'This credential resolved as a human user session instead of an API principal token. Sign in through the standard chat portal for user accounts.',
        );
        tokenInputRef.current?.focus();
        return;
      }

      pollEpochRef.current += 1;
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      activeConnectionEpochRef.current = epoch;
      activeTokenRef.current = validation.token;
      activeExecutionIdRef.current = '';
      setConnectionEpoch(epoch);
      setConnectedToken(validation.token);
      setSession(result);
      setConnectError('');
      setDisconnectNotice('');
      resetWorkspaceUi();
      setConnectionId((value) => value + 1);
    } catch (err) {
      if (epoch !== connectionEpochRef.current || abort.signal.aborted || (err as Error).name === 'AbortError') return;
      if (err instanceof ApiError && err.status === 401) {
        setConnectError(
          `Token verification failed (401). Confirm the token exists and is not expired or revoked. ${err.message}`,
        );
      } else if (err instanceof ApiError) {
        setConnectError(`Session introspection failed (${err.status}). ${err.message}`);
      } else {
        setConnectError(`Unable to reach auth session endpoint: ${(err as Error).message || 'network failure'}.`);
      }
    } finally {
      if (epoch === connectionEpochRef.current) {
        setConnecting(false);
      }
    }
  }

  async function refreshExecutionStatus() {
    const targetExecutionId = executionDebug.executionId;
    if (!connectedToken || !session || !targetExecutionId || executionPolling) return;
    if (!permits(session, 'agent:executions:read', `execution:${targetExecutionId}`)) {
      setExecutionPollError('This token lacks agent:executions:read permission to fetch execution snapshots.');
      return;
    }

    const epoch = connectionEpochRef.current;
    const tokenAtStart = connectedToken;
    if (
      !epoch ||
      epoch !== activeConnectionEpochRef.current ||
      targetExecutionId !== activeExecutionIdRef.current
    ) {
      return;
    }

    const pollEpoch = ++pollEpochRef.current;
    pollAbortRef.current?.abort();
    const abort = new AbortController();
    pollAbortRef.current = abort;
    setExecutionPolling(true);
    setExecutionPollError('');

    const isCurrentPoll = () =>
      epoch !== 0 &&
      epoch === connectionEpochRef.current &&
      epoch === activeConnectionEpochRef.current &&
      pollEpoch === pollEpochRef.current &&
      !abort.signal.aborted &&
      activeExecutionIdRef.current === targetExecutionId;

    try {
      const snapshot = await api<ExecutionStatusSnapshot>(
        `/api/chat/executions/${targetExecutionId}`,
        tokenAtStart,
        { method: 'GET', signal: abort.signal },
        { authMode: 'api-token', onUnauthorized: (err) => disconnectForEpoch(epoch, err) },
      );
      if (!isCurrentPoll()) return;
      if (snapshot.id && snapshot.id !== targetExecutionId) return;
      setExecutionPoll(snapshot);
    } catch (err) {
      if (!isCurrentPoll() || (err as Error).name === 'AbortError') return;
      setExecutionPollError((err as Error).message || 'Unable to inspect execution status.');
    } finally {
      if (
        epoch === connectionEpochRef.current &&
        epoch === activeConnectionEpochRef.current &&
        pollEpoch === pollEpochRef.current
      ) {
        setExecutionPolling(false);
      }
    }
  }

  function navigate(next: ApiPage) {
    setPage(next);
    window.location.hash = next;
  }

  const appearanceUtility = {
    type: 'menu-dropdown' as const,
    text: `Appearance: ${appearanceOptions.find((item) => item.value === appearance)!.label}`,
    items: appearanceOptions.map((item) => ({ id: item.value, text: item.label })),
    onItemClick: ({ detail }: { detail: { id: string } }) => setAppearance(detail.id as Appearance),
  };

  if (!session || !connectedToken) {
    return (
      <div className="api-test-disconnected">
        <div id="workspace-top-navigation">
          <TopNavigation
            identity={{ title: 'API token chat client', href: '#connect', onFollow: (event) => event.preventDefault() }}
            utilities={[appearanceUtility]}
            i18nStrings={{
              overflowMenuTriggerText: 'More',
              overflowMenuTitleText: 'More options',
              overflowMenuBackIconAriaLabel: 'Back',
              overflowMenuDismissIconAriaLabel: 'Close menu',
            }}
          />
        </div>
        <main className="login-page">
          <svg
            className="login-background-graph"
            viewBox="0 0 900 900"
            fill="none"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
            focusable="false"
          >
            <g stroke="currentColor" strokeWidth="2">
              <path d="M100 160 360 240 640 130 810 350 620 540 760 760 430 700 170 790 100 530 360 460 360 240M100 160 100 530M360 240 620 540 430 700 360 460 100 530M640 130 620 540M360 460 810 350M170 790 430 700" />
              {[
                [100, 160],
                [360, 240],
                [640, 130],
                [810, 350],
                [620, 540],
                [760, 760],
                [430, 700],
                [170, 790],
                [100, 530],
                [360, 460],
              ].map(([cx, cy]) => (
                <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="15" />
              ))}
            </g>
          </svg>
          <ContentLayout
            defaultPadding
            headerVariant="high-contrast"
            maxContentWidth={540}
            headerBackgroundStyle={colorBackgroundHomeHeader}
            header={
              <div className="login-hero" style={{ color: colorTextHomeHeaderDefault }}>
                <Box variant="h1" fontSize="display-l" fontWeight="bold" padding="n" textAlign="center">
                  API token chat client
                </Box>
                <Box variant="p" fontSize="heading-m" textAlign="center">
                  Validate API principal sessions and test agent execution with strict credential isolation.
                </Box>
              </div>
            }
          >
            <div className="login-card">
              <SpaceBetween size="l">
                {Boolean(disconnectNotice) && (
                  <Alert
                    type="info"
                    dismissible
                    onDismiss={() => setDisconnectNotice('')}
                    header="Connection closed"
                  >
                    {disconnectNotice}
                  </Alert>
                )}
                <Container
                  header={
                    <Header
                      variant="h2"
                      description="Authenticates directly with a Bearer token and sends no cookies or refresh requests."
                    >
                      Connect an API principal
                    </Header>
                  }
                >
                  <form
                    data-testid="api-token-connect-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void connect();
                    }}
                  >
                    <Form
                      actions={
                        <Button
                          data-testid="api-token-connect-button"
                          variant="primary"
                          formAction="submit"
                          loading={connecting}
                        >
                          Connect
                        </Button>
                      }
                    >
                      <SpaceBetween size="l">
                        <FormField
                          label="API token"
                          description="Held in React memory only for this browser tab."
                          constraintText="Issued tokens typically start with tcg_api_. Browser storage and autofill stay disabled."
                          errorText={tokenError}
                        >
                          <Input
                            ref={tokenInputRef}
                            data-testid="api-token-input-wrapper"
                            name="api-token"
                            type="password"
                            autoComplete="off"
                            value={tokenInput}
                            disabled={connecting}
                            placeholder="Enter API token"
                            nativeInputAttributes={{
                              ...settingsInputAttributes,
                              autoCapitalize: 'none',
                              autoCorrect: 'off',
                              spellCheck: false,
                              'data-testid': 'api-token-input',
                            }}
                            onChange={({ detail }) => {
                              setTokenInput(detail.value);
                              if (tokenError) setTokenError('');
                            }}
                          />
                        </FormField>
                        {Boolean(connectError) && (
                          <Alert data-testid="api-token-connect-error" type="error" header="Unable to connect">
                            {connectError}
                          </Alert>
                        )}
                      </SpaceBetween>
                    </Form>
                  </form>
                </Container>
                <Container header={<Header variant="h2">Configured destinations</Header>}>
                  <KeyValuePairs
                    columns={1}
                    items={[
                      { label: 'Auth introspection endpoint', value: `${destinations.auth}/session` },
                      { label: 'Chat API endpoint', value: destinations.chat },
                    ]}
                  />
                </Container>
              </SpaceBetween>
            </div>
          </ContentLayout>
        </main>
      </div>
    );
  }

  const chatMode = page === 'chat';
  const statusMeta = EXECUTION_STATUS_LABELS[executionDebug.status];
  const canInspectExecution =
    !!executionDebug.executionId &&
    permits(session, 'agent:executions:read', `execution:${executionDebug.executionId}`);

  const routeStyle = {
    '--api-test-divider': colorBorderDividerDefault,
    '--api-test-surface': colorBackgroundContainerContent,
  } as CSSProperties;

  const inspectorPanel = (
    <Box padding="l">
      <SpaceBetween size="l">
        <Header variant="h2" description="Live principal identity, capabilities, and execution state for this tab.">
          Principal and debugging
        </Header>

        <Container header={<Header variant="h3">Connected principal</Header>}>
          <KeyValuePairs
            columns={1}
            items={[
              { label: 'Principal name', value: session.username },
              { label: 'Principal ID', value: session.id },
              { label: 'Principal type', value: 'API principal (api)' },
              { label: 'Assigned role', value: roleLabel(session) },
              { label: 'Key reference', value: session.key_reference || 'Unavailable' },
              { label: 'Auth destination', value: `${destinations.auth}/session` },
              { label: 'Chat destination', value: destinations.chat },
            ]}
          />
        </Container>

        <Container header={<Header variant="h3">Daily allowance</Header>}>
          {usageSnapshot ? (
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: 'Remaining tokens',
                  value: `${usageSnapshot.remaining_tokens.toLocaleString()} of ${usageSnapshot.daily_token_limit.toLocaleString()}`,
                },
                { label: 'Tokens used today', value: usageSnapshot.total_tokens.toLocaleString() },
                {
                  label: 'Usage status',
                  value: usageSnapshot.unverified_usage
                    ? 'Unverified (requests blocked)'
                    : usageSnapshot.daily_token_limit === 0
                      ? 'Limit set to 0 (blocked)'
                      : usageSnapshot.remaining_tokens === 0
                        ? 'Quota exhausted'
                        : 'Available',
                },
              ]}
            />
          ) : (
            <Box color="text-body-secondary">
              {usageError || 'Checking principal usage.'}
            </Box>
          )}
        </Container>

        <Container
          header={
            <Header variant="h3" description="Read-only state tracked for the active request.">
              Execution state
            </Header>
          }
        >
          <SpaceBetween size="m">
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: 'Stream state',
                  value: <StatusIndicator type={statusMeta.type}>{statusMeta.label}</StatusIndicator>,
                },
                { label: 'Conversation ID', value: executionDebug.conversationId || 'None' },
                { label: 'Execution ID', value: executionDebug.executionId || 'None' },
              ]}
            />
            {Boolean(executionDebug.executionId) && (
              canInspectExecution ? (
                <SpaceBetween size="xs">
                  <Button
                    data-testid="refresh-execution-status-button"
                    loading={executionPolling}
                    onClick={() => void refreshExecutionStatus()}
                  >
                    Refresh execution status
                  </Button>
                  {Boolean(executionPollError) && <Alert type="error">{executionPollError}</Alert>}
                  {executionPoll && (
                    <KeyValuePairs
                      columns={1}
                      items={[
                        { label: 'Server status', value: executionPoll.status },
                        {
                          label: 'Recorded events',
                          value: String(executionPoll.events ? executionPoll.events.length : 0),
                        },
                      ]}
                    />
                  )}
                </SpaceBetween>
              ) : (
                <Box fontSize="body-s" color="text-body-secondary">
                  Fetching execution snapshots requires agent:executions:read.
                </Box>
              )
            )}
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header variant="h3" description="Evaluated locally from introspected policy statements.">
              Agent capabilities
            </Header>
          }
        >
          <SpaceBetween size="xs">
            {AGENT_CAPABILITIES.map((cap) => {
              const capability = evaluateAgentCapability(session, cap.action, {
                models: availableModels,
                selectedModelId,
                conversationId: executionDebug.conversationId,
                executionId: executionDebug.executionId,
              });
              const detail = capability.detail ? ` — ${capability.detail}` : '';
              return (
                <div key={cap.action} data-testid={`capability-${cap.action}`}>
                  <StatusIndicator type={capability.type}>
                    {`${cap.action} — ${capability.label} (${cap.description})${detail}`}
                  </StatusIndicator>
                </div>
              );
            })}
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </Box>
  );

  return (
    <ClientTransportContext.Provider value={{ authMode: 'api-token', onUnauthorized: handleUnauthorized }}>
      <div id="workspace-top-navigation">
        <TopNavigation
          identity={{
            title: 'API token chat client',
            href: '#chat',
            onFollow: (event) => {
              event.preventDefault();
              navigate('chat');
            },
          }}
          utilities={[
            appearanceUtility,
            {
              type: 'menu-dropdown',
              text: session.username,
              iconName: 'user-profile',
              description: `${roleLabel(session)}${session.key_reference ? ` · ${session.key_reference}` : ''}`,
              items: [
                { id: 'chat', text: 'Deck agent' },
                { id: 'preferences', text: 'Agent preferences' },
                { id: 'inspector', text: toolsOpen ? 'Hide principal and debugging' : 'Principal and debugging' },
              ],
              onItemClick: ({ detail }) => {
                if (detail.id === 'chat') navigate('chat');
                if (detail.id === 'preferences') navigate('preferences');
                if (detail.id === 'inspector') setToolsOpen((open) => !open);
              },
            },
            {
              type: 'button',
              text: 'Disconnect',
              onClick: () =>
                disconnect(
                  'Disconnected locally. The API token remains active on the server until revoked by an administrator.',
                ),
            },
          ]}
          i18nStrings={{
            overflowMenuTriggerText: 'More',
            overflowMenuTitleText: 'More options',
            overflowMenuBackIconAriaLabel: 'Back',
            overflowMenuDismissIconAriaLabel: 'Close menu',
          }}
        />
      </div>

      <AppLayoutToolbar
        notifications={
          connectError ? (
            <Flashbar
              items={[
                {
                  id: 'api-token-notice',
                  type: 'error',
                  content: connectError,
                  dismissible: true,
                  onDismiss: () => setConnectError(''),
                },
              ]}
            />
          ) : undefined
        }
        navigationWidth={chatMode ? 340 : 280}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        toolsOpen={toolsOpen}
        onToolsChange={({ detail }) => setToolsOpen(detail.open)}
        tools={inspectorPanel}
        toolsWidth={340}
        splitPanelOpen={artifactOpen}
        onSplitPanelToggle={({ detail }) => setArtifactOpen(detail.open)}
        splitPanelSize={panelSize}
        onSplitPanelResize={({ detail }) => setPanelSize(detail.size)}
        splitPanelPreferences={panelPreferences}
        onSplitPanelPreferencesChange={({ detail }) => setPanelPreferences(detail)}
        splitPanel={
          artifact && page === 'chat' ? (
            <SplitPanel
              header={artifactTitle(artifact)}
              closeBehavior="hide"
              headerDescription="Review card details, quotations and dated source evidence."
              i18nStrings={{
                closeButtonAriaLabel: 'Close result preview',
                openButtonAriaLabel: 'Open result preview',
                resizeHandleAriaLabel: 'Resize result preview',
                resizeHandleTooltipText: 'Drag to resize the preview and chat, or use the arrow keys',
                preferencesTitle: 'Result preview position',
                preferencesPositionLabel: 'Position',
                preferencesPositionDescription: 'Choose where to review the result.',
                preferencesPositionSide: 'Side',
                preferencesPositionBottom: 'Bottom',
                preferencesConfirm: 'Confirm',
                preferencesCancel: 'Cancel',
              }}
            >
              <ArtifactContent artifact={artifact} />
            </SplitPanel>
          ) : undefined
        }
        ariaLabels={{
          navigation: 'Workspace navigation',
          navigationToggle: 'Open navigation',
          navigationClose: 'Close navigation',
          tools: 'Principal and debugging',
          toolsToggle: 'Open principal and debugging',
          toolsClose: 'Close principal and debugging',
        }}
        headerSelector="#workspace-top-navigation"
        contentType="default"
        navigation={
          <>
            <div hidden={!chatMode} className="chat-navigation-host" ref={setChatNavigation} />
            <div hidden={chatMode}>
              <SideNavigation
                data-testid="api-test-navigation"
                header={{ href: '#chat', text: 'API test workspace' }}
                activeHref={`#${page}`}
                onFollow={(event) => {
                  if (!event.detail.external) {
                    event.preventDefault();
                    navigate((event.detail.href.slice(1) as ApiPage) || 'chat');
                  }
                }}
                items={[
                  { type: 'link', text: 'Deck agent', href: '#chat' },
                  { type: 'link', text: 'Agent preferences', href: '#preferences' },
                ]}
              />
            </div>
          </>
        }
        content={
          <>
            <div className="api-test-chat-route" style={routeStyle} hidden={page === 'preferences'}>
              <div className="api-test-status-strip" data-testid="api-principal-banner">
                <div className="api-test-status-inner">
                  <div className="api-test-status-meta">
                    <Badge color="blue">API principal</Badge>
                    <Box fontWeight="bold">{session.username}</Box>
                    <Box color="text-body-secondary">{roleLabel(session)}</Box>
                    {session.key_reference && (
                      <Box color="text-body-secondary">{`Key: ${session.key_reference}`}</Box>
                    )}
                    {executionDebug.executionId && (
                      <Box fontSize="body-s" color="text-body-secondary">
                        {`Exec: ${executionDebug.executionId}`}
                      </Box>
                    )}
                  </div>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      variant="normal"
                      onClick={() => setToolsOpen((open) => !open)}
                      ariaExpanded={toolsOpen}
                    >
                      Principal and debugging
                    </Button>
                  </SpaceBetween>
                </div>
              </div>
              <div className="api-test-chat-body">
                <Chat
                  key={connectionId}
                  token={connectedToken}
                  authMode="api-token"
                  onUnauthorized={handleUnauthorized}
                  session={session}
                  onUsageChange={handleUsageChange}
                  onExecutionStateChange={handleExecutionStateChange}
                  onModelsChange={handleModelsChange}
                  onPreview={(value) => {
                    setArtifact(value);
                    setArtifactOpen(!!value);
                  }}
                  navigationContainer={chatNavigation}
                  onConversationSelected={() => {
                    if (window.matchMedia('(max-width: 688px)').matches) setNavigationOpen(false);
                  }}
                />
              </div>
            </div>
            {page === 'preferences' && (
              <div>
                <ContentLayout>
                  <Preferences
                    key={connectionId}
                    token={connectedToken}
                    authMode="api-token"
                    onUnauthorized={handleUnauthorized}
                    session={session}
                  />
                </ContentLayout>
              </div>
            )}
          </>
        }
      />
    </ClientTransportContext.Provider>
  );
}
