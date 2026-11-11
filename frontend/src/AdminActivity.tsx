import React, { useEffect, useState, useRef } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  ColumnLayout,
  Container,
  ExpandableSection,
  FormField,
  Grid,
  Header,
  Input,
  Link,
  Modal,
  Pagination,
  SegmentedControl,
  Select,
  SpaceBetween,
  StatusIndicator,
  Table,
  Tabs,
  Textarea,
  TextFilter,
} from '@cloudscape-design/components';
import { api, stream } from './client';
import { AdminExecutionDetail, AdminExecutionSummary, LegalityStatus, Model, AgentEvent } from './contracts';
import { Markdown } from './Markdown';

interface AdminActivityProps {
  token: string;
}

export function statusIndicatorType(
  status: string
): 'success' | 'loading' | 'error' | 'stopped' | 'info' {
  switch (status) {
    case 'complete':
      return 'success';
    case 'running':
      return 'loading';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'stopped';
    case 'waiting':
      return 'info';
    default:
      return 'info';
  }
}

export const AdminActivity: React.FC<AdminActivityProps> = ({ token }) => {
  const [activeView, setActiveView] = useState<'activity' | 'playground'>('activity');
  const [executions, setExecutions] = useState<AdminExecutionSummary[]>([]);
  const [legality, setLegality] = useState<LegalityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingLegality, setRefreshingLegality] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedExecution, setSelectedExecution] = useState<AdminExecutionDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  // Playground state
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [playgroundThreadId, setPlaygroundThreadId] = useState<string>('');
  const [playgroundPrompt, setPlaygroundPrompt] = useState('');
  const [playgroundRunning, setPlaygroundRunning] = useState(false);
  const [playgroundError, setPlaygroundError] = useState<string | null>(null);
  const [playgroundExecutionId, setPlaygroundExecutionId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('trace');
  const [decisionText, setDecisionText] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [execList, legStatus] = await Promise.all([
        api<AdminExecutionSummary[]>('/api/admin/activity', token),
        api<LegalityStatus>('/api/admin/legality/status', token),
      ]);
      setExecutions(execList || []);
      setLegality(legStatus || null);
    } catch (err: any) {
      setError(err.message || 'Failed to load activity or legality status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    void api<Model[]>('/api/chat/models', token)
      .then((items) => {
        setModels(items || []);
        if (items?.length && !selectedModel) {
          setSelectedModel(items[0].id);
        }
      })
      .catch(() => {});
  }, [token]);

  const handleRefreshLegality = async () => {
    setRefreshingLegality(true);
    setError(null);
    try {
      const updated = await api<LegalityStatus>('/api/admin/legality/refresh', token, { method: 'POST' });
      setLegality(updated);
    } catch (err: any) {
      setError(err.message || 'Failed to refresh legality database.');
    } finally {
      setRefreshingLegality(false);
    }
  };

  const handleViewDetail = async (executionId: string) => {
    setLoadingDetailId(executionId);
    try {
      const detail = await api<AdminExecutionDetail>(`/api/admin/activity/${executionId}`, token);
      setSelectedExecution(detail);
      setPlaygroundThreadId(detail.conversation_id);
      setPlaygroundExecutionId(detail.id);
      if (detail.model_id) setSelectedModel(detail.model_id);
    } catch (err: any) {
      setError(err.message || 'Failed to load execution detail.');
    } finally {
      setLoadingDetailId(null);
    }
  };

  const selectThread = async (conversationId: string) => {
    setPlaygroundThreadId(conversationId);
    // Find the latest execution for this conversation
    const match = executions.find((e) => e.conversation_id === conversationId);
    if (match) {
      await handleViewDetail(match.id);
    }
  };

  const startNewThread = () => {
    setPlaygroundThreadId('');
    setPlaygroundExecutionId('');
    setSelectedExecution(null);
    setPlaygroundPrompt('');
    setDecisionText('');
  };

  const runPlaygroundPrompt = async () => {
    if (!playgroundPrompt.trim() || playgroundRunning) return;
    setPlaygroundRunning(true);
    setPlaygroundError(null);
    const text = playgroundPrompt.trim();
    setPlaygroundPrompt('');

    const body: Record<string, unknown> = {
      text,
      model_id: selectedModel || models[0]?.id || 'gpt-6-luna',
    };
    if (playgroundThreadId) {
      body.conversation_id = playgroundThreadId;
    }

    let createdExecId = playgroundExecutionId;
    try {
      await stream('/api/chat/executions', token, body, (ev: AgentEvent) => {
        if (ev.type === 'execution') {
          createdExecId = ev.data.id;
          setPlaygroundExecutionId(ev.data.id);
          setPlaygroundThreadId(ev.data.conversation_id);
        }
      });
      await loadData();
      if (createdExecId) {
        await handleViewDetail(createdExecId);
      }
    } catch (err: any) {
      setPlaygroundError(err.message || 'Execution error');
    } finally {
      setPlaygroundRunning(false);
    }
  };

  const submitDecision = async (action: string) => {
    if (!selectedExecution || playgroundRunning) return;
    setPlaygroundRunning(true);
    setPlaygroundError(null);
    const body = {
      action,
      approved: action !== 'cancel',
      text: decisionText.trim() || (action === 'keep_missing' ? 'Approved' : ''),
      selected_option: action === 'clarify' ? decisionText.trim() : undefined,
    };
    setDecisionText('');

    try {
      await stream(
        `/api/chat/executions/${selectedExecution.id}/resume`,
        token,
        body,
        (ev: AgentEvent) => {}
      );
      await loadData();
      await handleViewDetail(selectedExecution.id);
    } catch (err: any) {
      setPlaygroundError(err.message || 'Resume error');
    } finally {
      setPlaygroundRunning(false);
    }
  };

  const filtered = executions.filter(
    (e) =>
      e.id.toLowerCase().includes(filterText.toLowerCase()) ||
      e.conversation_title.toLowerCase().includes(filterText.toLowerCase()) ||
      e.model_id.toLowerCase().includes(filterText.toLowerCase()) ||
      e.status.toLowerCase().includes(filterText.toLowerCase())
  );

  const pageSize = 10;
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Group threads
  const threadsMap = new Map<string, { title: string; count: number; latest: AdminExecutionSummary }>();
  for (const exec of executions) {
    const existing = threadsMap.get(exec.conversation_id);
    if (!existing) {
      threadsMap.set(exec.conversation_id, {
        title: exec.conversation_title || 'Untitled Thread',
        count: 1,
        latest: exec,
      });
    } else {
      existing.count += 1;
    }
  }
  const threads = Array.from(threadsMap.entries()).map(([convId, data]) => ({
    conversation_id: convId,
    ...data,
  }));

  const activeConversationId = playgroundThreadId || selectedExecution?.conversation_id;
  const threadExecutions = executions.filter(
    (e) => activeConversationId && e.conversation_id === activeConversationId
  );

  const transcriptGroups: Array<{
    type: 'user' | 'trace' | 'single';
    message?: any;
    items?: any[];
  }> = [];
  let currentTrace: any[] = [];
  for (const m of selectedExecution?.messages || []) {
    const isAssistant = m.role === 'assistant';
    const cType = m.content?.type;
    if (isAssistant && (cType === 'thinking' || cType === 'tool')) {
      currentTrace.push(m);
    } else {
      if (currentTrace.length > 0) {
        transcriptGroups.push({ type: 'trace', items: [...currentTrace] });
        currentTrace = [];
      }
      transcriptGroups.push({ type: m.role === 'user' ? 'user' : 'single', message: m });
    }
  }
  if (currentTrace.length > 0) {
    transcriptGroups.push({ type: 'trace', items: [...currentTrace] });
  }

  return (
    <SpaceBetween size="l">
      {/* View Switcher */}
      <Header
        variant="h1"
        description="Comprehensive monitoring, legality catalog status, and live AI Foundry-style agent testing."
        actions={
          <SegmentedControl
            selectedId={activeView}
            onChange={({ detail }) => setActiveView(detail.selectedId as 'activity' | 'playground')}
            options={[
              { id: 'activity', text: 'Activity Log & Legality' },
              { id: 'playground', text: 'Foundry Agentic Playground' },
            ]}
          />
        }
      >
        Admin Activity &amp; Agent Playground
      </Header>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Legality Catalog Card (always available) */}
      <Container
        header={
          <Header
            variant="h2"
            description="PostgreSQL legality catalog for International and Japan rulesets, Standard & Expanded formats."
            actions={
              <Button
                variant="primary"
                loading={refreshingLegality}
                onClick={handleRefreshLegality}
              >
                Refresh Legality Now
              </Button>
            }
          >
            Legality Catalog Status
          </Header>
        }
      >
        {legality ? (
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box color="text-body-secondary">Sync Status</Box>
              <StatusIndicator
                type={legality.status === 'synced' ? 'success' : legality.status === 'failed' ? 'error' : 'info'}
              >
                {legality.status.toUpperCase()}
              </StatusIndicator>
            </div>
            <div>
              <Box color="text-body-secondary">Last Refreshed</Box>
              <Box>
                {legality.last_refreshed_at ? new Date(legality.last_refreshed_at).toLocaleString() : 'Never'}
              </Box>
            </div>
            <div>
              <Box color="text-body-secondary">Next Scheduled Refresh</Box>
              <Box>
                {legality.next_refresh_at ? new Date(legality.next_refresh_at).toLocaleString() : 'Weekly'}
              </Box>
            </div>
            <div>
              <Box color="text-body-secondary">Catalog Counts</Box>
              <Box>
                {legality.sets_count} Sets · {legality.banned_count} Banned Cards
              </Box>
            </div>
          </ColumnLayout>
        ) : (
          <StatusIndicator type="loading">Loading legality catalog...</StatusIndicator>
        )}
      </Container>

      {activeView === 'activity' ? (
        /* Standard Table View */
        <Table
          loading={loading}
          loadingText="Loading executions and reasoning logs..."
          items={paged}
          header={
            <Header
              variant="h2"
              description="Inspect agent model reasoning traces, tool executions, and step-by-step activity history."
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => {
                      setActiveView('playground');
                      if (executions[0]) void handleViewDetail(executions[0].id);
                    }}
                  >
                    Open in Playground
                  </Button>
                  <Button iconName="refresh" onClick={loadData}>
                    Refresh
                  </Button>
                </SpaceBetween>
              }
            >
              Agent Activity &amp; Reasoning Log
            </Header>
          }
          filter={
            <TextFilter
              filteringText={filterText}
              filteringPlaceholder="Filter by title, model, or execution ID"
              onChange={({ detail }) => {
                setFilterText(detail.filteringText);
                setCurrentPage(1);
              }}
            />
          }
          pagination={
            <Pagination
              currentPageIndex={currentPage}
              pagesCount={Math.ceil(filtered.length / pageSize) || 1}
              onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
            />
          }
          columnDefinitions={[
            {
              id: 'id',
              header: 'Execution ID',
              cell: (e) => <Box variant="code">{e.id.slice(0, 8)}...</Box>,
            },
            {
              id: 'conversation',
              header: 'Conversation',
              cell: (e) => e.conversation_title || 'Untitled',
            },
            {
              id: 'model',
              header: 'Model',
              cell: (e) => e.model_id,
            },
            {
              id: 'status',
              header: 'Status',
              cell: (e) => (
                <StatusIndicator type={statusIndicatorType(e.status)}>
                  {e.status}
                </StatusIndicator>
              ),
            },
            {
              id: 'date',
              header: 'Time',
              cell: (e) => new Date(e.created_at).toLocaleString(),
            },
            {
              id: 'actions',
              header: 'Action',
              cell: (e) => (
                <Button
                  variant="inline-link"
                  loading={loadingDetailId === e.id}
                  onClick={() => handleViewDetail(e.id)}
                >
                  View reasoning &amp; trace
                </Button>
              ),
            },
          ]}
        />
      ) : (
        /* Azure AI Foundry-Style 3-Pane Agentic Playground */
        <Grid
          gridDefinition={[
            { colspan: { default: 12, s: 12, m: 3, l: 3 } },
            { colspan: { default: 12, s: 12, m: 5, l: 5 } },
            { colspan: { default: 12, s: 12, m: 4, l: 4 } },
          ]}
        >
          {/* Pane 1: Threads Navigator */}
          <Container
            header={
              <Header
                variant="h3"
                actions={
                  <Button variant="primary" iconName="add-plus" onClick={startNewThread}>
                    New
                  </Button>
                }
              >
                Threads ({threads.length})
              </Header>
            }
          >
            <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <SpaceBetween size="s">
                {threads.map((th) => {
                  const isSelected = th.conversation_id === playgroundThreadId;
                  return (
                    <div
                      key={th.conversation_id}
                      onClick={() => selectThread(th.conversation_id)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        border: isSelected
                          ? '2px solid var(--color-border-status-info, #0073bb)'
                          : '1px solid var(--color-border-divider-default, #eaeded)',
                        backgroundColor: isSelected
                          ? 'var(--color-background-item-selected, #f2f8fd)'
                          : 'var(--color-background-container-content, #ffffff)',
                      }}
                    >
                      <Box fontWeight="bold" fontSize="body-s">
                        {th.title}
                      </Box>
                      <SpaceBetween direction="horizontal" size="xs">
                        <StatusIndicator type={statusIndicatorType(th.latest.status)}>
                          {th.latest.status}
                        </StatusIndicator>
                        <Badge color="grey">{th.latest.model_id}</Badge>
                      </SpaceBetween>
                      <Box fontSize="body-s" color="text-body-secondary">
                        {new Date(th.latest.created_at).toLocaleDateString()} · {th.count} run{th.count > 1 ? 's' : ''}
                      </Box>
                    </div>
                  );
                })}
              </SpaceBetween>
            </div>
          </Container>

          {/* Pane 2: Multi-Turn Conversation & Runner */}
          <Container
            header={
              <Header
                variant="h3"
                description={
                  selectedExecution
                    ? `Execution: ${selectedExecution.id.slice(0, 8)}... (${selectedExecution.status})`
                    : 'New session'
                }
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    {threadExecutions.length > 1 && (
                      <Select
                        selectedOption={
                          selectedExecution
                            ? {
                                value: selectedExecution.id,
                                label: `Run ${selectedExecution.id.slice(0, 8)}... (${selectedExecution.status})`,
                              }
                            : null
                        }
                        onChange={({ detail }) => {
                          if (detail.selectedOption.value) {
                            void handleViewDetail(detail.selectedOption.value);
                          }
                        }}
                        options={threadExecutions.map((e) => ({
                          value: e.id,
                          label: `Run ${e.id.slice(0, 8)}... (${e.status})`,
                        }))}
                        placeholder="Select run"
                      />
                    )}
                    <Select
                      selectedOption={
                        selectedModel
                          ? { value: selectedModel, label: models.find((m) => m.id === selectedModel)?.label || selectedModel }
                          : null
                      }
                      onChange={({ detail }) => setSelectedModel(detail.selectedOption.value || '')}
                      options={models.map((m) => ({ value: m.id, label: m.label }))}
                      placeholder="Select model"
                    />
                  </SpaceBetween>
                }
              >
                {selectedExecution?.conversation_title || 'Playground Transcript'}
              </Header>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', height: '70vh' }}>
              {/* Transcript Scroll Area */}
              <div style={{ flex: 1, overflowY: 'auto', paddingRight: '8px' }}>
                <SpaceBetween size="m">
                  {transcriptGroups.length > 0 ? (
                    transcriptGroups.map((group, gIdx) => {
                      if (group.type === 'user') {
                        const m = group.message;
                        const content = m?.content || {};
                        return (
                          <div
                            key={m?.id || gIdx}
                            style={{
                              alignSelf: 'flex-end',
                              maxWidth: '85%',
                              marginLeft: 'auto',
                              padding: '10px 14px',
                              borderRadius: '8px',
                              backgroundColor: 'var(--color-background-container-header, #f4f6f8)',
                              border: '1px solid var(--color-border-divider-default, #eaeded)',
                            }}
                          >
                            <Box fontWeight="bold" fontSize="body-s" color="text-body-secondary">
                              USER · {new Date(m.created_at).toLocaleTimeString()}
                            </Box>
                            {content.decision && (
                              <Badge color="blue">
                                Decision: {content.decision.action} ({content.decision.text || 'approved'})
                              </Badge>
                            )}
                            {content.text && <Box>{content.text}</Box>}
                          </div>
                        );
                      }

                      if (group.type === 'trace') {
                        const traceItems = group.items || [];
                        return (
                          <div
                            key={`trace-${gIdx}`}
                            style={{
                              maxWidth: '90%',
                              padding: '10px 14px',
                              borderRadius: '8px',
                              backgroundColor: 'var(--color-background-container-content, #ffffff)',
                              border: '1px solid var(--color-border-divider-default, #eaeded)',
                            }}
                          >
                            <Box fontWeight="bold" fontSize="body-s" color="text-body-secondary">
                              ASSISTANT · {traceItems[0] ? new Date(traceItems[0].created_at).toLocaleTimeString() : ''}
                            </Box>
                            <ExpandableSection
                              headerText={`Agent reasoning & tool trace (${traceItems.length} step${traceItems.length === 1 ? '' : 's'})`}
                            >
                              <SpaceBetween size="s">
                                {traceItems.map((item, iIdx) => {
                                  const content = item.content || {};
                                  if (content.type === 'thinking' && content.data?.summary) {
                                    const isProvider = content.data?.source === 'provider_summary';
                                    return (
                                      <div key={item.id || iIdx} style={{ padding: '4px 0' }}>
                                        <Box fontWeight="bold" fontSize="body-s">
                                          {isProvider ? 'Model reasoning summary:' : 'Approach summary:'}
                                        </Box>
                                        <Markdown content={content.data.summary} />
                                      </div>
                                    );
                                  }
                                  if (content.type === 'tool') {
                                    const tStatus =
                                      content.data?.status === 'error'
                                        ? 'error'
                                        : content.data?.status === 'loading'
                                        ? 'loading'
                                        : 'success';
                                    return (
                                      <div
                                        key={item.id || iIdx}
                                        style={{ fontSize: '0.85em', color: '#545b64', padding: '2px 0' }}
                                      >
                                        <StatusIndicator type={tStatus}>
                                          <strong>Tool: {content.data?.name}</strong>{' '}
                                          {content.data?.duration_ms ? `(${content.data.duration_ms} ms)` : ''}
                                        </StatusIndicator>
                                      </div>
                                    );
                                  }
                                  return null;
                                })}
                              </SpaceBetween>
                            </ExpandableSection>
                          </div>
                        );
                      }

                      // Single assistant message (cards, question, result)
                      const m = group.message;
                      const content = m?.content || {};
                      return (
                        <div
                          key={m?.id || gIdx}
                          style={{
                            maxWidth: '90%',
                            padding: '10px 14px',
                            borderRadius: '8px',
                            backgroundColor: 'var(--color-background-container-content, #ffffff)',
                            border: '1px solid var(--color-border-divider-default, #eaeded)',
                          }}
                        >
                          <Box fontWeight="bold" fontSize="body-s" color="text-body-secondary">
                            ASSISTANT · {new Date(m.created_at).toLocaleTimeString()}
                          </Box>
                          {content.type === 'cards' && content.data?.cards && (
                            <Box>
                              <Badge color="green">
                                Resolved {content.data.cards.length} deck cards
                              </Badge>
                            </Box>
                          )}
                          {content.type === 'question' && (
                            <Alert type="info" header="Clarification Required">
                              {content.data?.question}
                            </Alert>
                          )}
                          {content.type === 'result' && (
                            <Markdown content={content.data?.recommendation || 'Purchase plan ready.'} />
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <Box color="text-body-secondary" textAlign="center" padding="l">
                      Select a conversation thread or run a test prompt below.
                    </Box>
                  )}
                </SpaceBetween>
              </div>

              {/* Waiting Decision Panel */}
              {selectedExecution?.status === 'waiting' && (
                <div style={{ marginTop: '12px', padding: '12px', border: '1px solid #0073bb', borderRadius: '6px' }}>
                  <SpaceBetween size="xs">
                    <Box fontWeight="bold">Action Required: Agent Paused</Box>
                    <Input
                      value={decisionText}
                      onChange={({ detail }) => setDecisionText(detail.value)}
                      placeholder="Clarification response or approved substitute"
                    />
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button
                        variant="primary"
                        loading={playgroundRunning}
                        onClick={() => submitDecision('clarify')}
                      >
                        Clarify
                      </Button>
                      <Button
                        loading={playgroundRunning}
                        onClick={() => submitDecision('keep_missing')}
                      >
                        Keep Missing
                      </Button>
                      <Button
                        loading={playgroundRunning}
                        onClick={() => submitDecision('substitute')}
                      >
                        Substitute
                      </Button>
                      <Button
                        loading={playgroundRunning}
                        onClick={() => submitDecision('cancel')}
                      >
                        Cancel Run
                      </Button>
                    </SpaceBetween>
                  </SpaceBetween>
                </div>
              )}

              {/* Playground Composer */}
              <div style={{ marginTop: '12px' }}>
                <SpaceBetween size="xs">
                  {playgroundError && (
                    <Alert type="error" dismissible onDismiss={() => setPlaygroundError(null)}>
                      {playgroundError}
                    </Alert>
                  )}
                  <Textarea
                    value={playgroundPrompt}
                    onChange={({ detail }) => setPlaygroundPrompt(detail.value)}
                    placeholder="Enter test prompt (e.g. 'Help me build a M Lucario ex deck for standard format')"
                    rows={3}
                  />
                  <Box float="right">
                    <Button
                      variant="primary"
                      iconName="send"
                      loading={playgroundRunning}
                      disabled={!playgroundPrompt.trim()}
                      onClick={runPlaygroundPrompt}
                    >
                      Run in Playground
                    </Button>
                  </Box>
                </SpaceBetween>
              </div>
            </div>
          </Container>

          {/* Pane 3: Deep Trace & State Inspector */}
          <Container header={<Header variant="h3">Trace &amp; State Inspector</Header>}>
            <Tabs
              activeTabId={activeTab}
              onChange={({ detail }) => setActiveTab(detail.activeTabId)}
              tabs={[
                {
                  id: 'trace',
                  label: 'Trace Tree',
                  content: (
                    <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                      <SpaceBetween size="xs">
                        {selectedExecution?.events && selectedExecution.events.length > 0 ? (
                          selectedExecution.events.map((ev, eIdx) => {
                            const p = ev.payload || {};
                            return (
                              <ExpandableSection
                                key={ev.id || eIdx}
                                headerText={
                                  <span>
                                    <StatusIndicator
                                      type={
                                        p.status === 'error'
                                          ? 'error'
                                          : p.status === 'loading'
                                          ? 'loading'
                                          : 'success'
                                      }
                                    >
                                      <strong>{ev.kind.toUpperCase()}</strong>{' '}
                                      {p.name ? `· ${p.name}` : ''}
                                    </StatusIndicator>
                                    {p.duration_ms !== undefined && (
                                      <span style={{ fontSize: '0.8em', color: '#545b64', marginLeft: '8px' }}>
                                        {p.duration_ms} ms
                                      </span>
                                    )}
                                  </span>
                                }
                              >
                                {p.summary ? (
                                  <Markdown content={p.summary} />
                                ) : (
                                  <pre style={{ margin: 0, fontSize: '11px', overflowX: 'auto' }}>
                                    {JSON.stringify(p, null, 2)}
                                  </pre>
                                )}
                              </ExpandableSection>
                            );
                          })
                        ) : (
                          <Box color="text-body-secondary">No trace events available.</Box>
                        )}
                      </SpaceBetween>
                    </div>
                  ),
                },
                {
                  id: 'reasoning',
                  label: 'Reasoning',
                  content: (
                    <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                      {selectedExecution?.reasoning_summary ? (
                        <Markdown content={selectedExecution.reasoning_summary} />
                      ) : (
                        <Box color="text-body-secondary">No reasoning summary logged for this execution.</Box>
                      )}
                    </div>
                  ),
                },
                {
                  id: 'state',
                  label: 'State',
                  content: (
                    <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                      {selectedExecution?.checkpoint ? (
                        <SpaceBetween size="s">
                          <ExpandableSection defaultExpanded headerText="Checkpoint State JSON">
                            <pre style={{ margin: 0, fontSize: '11px', overflowX: 'auto' }}>
                              {JSON.stringify(selectedExecution.checkpoint, null, 2)}
                            </pre>
                          </ExpandableSection>
                        </SpaceBetween>
                      ) : (
                        <Box color="text-body-secondary">No checkpoint saved.</Box>
                      )}
                    </div>
                  ),
                },
                {
                  id: 'audit',
                  label: 'Audit',
                  content: (
                    <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                      <SpaceBetween size="xs">
                        {selectedExecution?.logs && selectedExecution.logs.length > 0 ? (
                          selectedExecution.logs.map((log) => (
                            <Box key={log.id} fontSize="body-s">
                              <strong>{log.action}</strong> ·{' '}
                              <span style={{ color: '#687078' }}>
                                {new Date(log.created_at).toLocaleTimeString()}
                              </span>
                              {log.details && (
                                <pre style={{ margin: '4px 0 0 0', overflowX: 'auto', fontSize: '11px' }}>
                                  {JSON.stringify(log.details, null, 2)}
                                </pre>
                              )}
                            </Box>
                          ))
                        ) : (
                          <Box color="text-body-secondary">No audit logs for this execution.</Box>
                        )}
                      </SpaceBetween>
                    </div>
                  ),
                },
              ]}
            />
          </Container>
        </Grid>
      )}

      {/* Modal Dialog for Table Click */}
      {selectedExecution && activeView === 'activity' && (
        <Modal
          visible
          size="max"
          header={`Execution Details — ${selectedExecution.conversation_title}`}
          closeAriaLabel="Close execution details"
          onDismiss={() => setSelectedExecution(null)}
        >
          <SpaceBetween size="l">
            <ColumnLayout columns={4} variant="text-grid">
              <div>
                <Box color="text-body-secondary">Execution ID</Box>
                <Box variant="code">{selectedExecution.id}</Box>
              </div>
              <div>
                <Box color="text-body-secondary">Model</Box>
                <Box>{selectedExecution.model_id}</Box>
              </div>
              <div>
                <Box color="text-body-secondary">Status</Box>
                <StatusIndicator type={statusIndicatorType(selectedExecution.status)}>
                  {selectedExecution.status}
                </StatusIndicator>
              </div>
              <div>
                <Box color="text-body-secondary">Timestamp</Box>
                <Box>{new Date(selectedExecution.created_at).toLocaleString()}</Box>
              </div>
            </ColumnLayout>

            {selectedExecution.reasoning_summary ? (
              <Container header={<Header variant="h3">Model Reasoning Trace</Header>}>
                <Markdown content={selectedExecution.reasoning_summary} />
              </Container>
            ) : null}

            <Container header={<Header variant="h3">Execution Events &amp; Tool History</Header>}>
              <SpaceBetween size="s">
                {selectedExecution.events.map((ev, i) => (
                  <ExpandableSection
                    key={ev.id || i}
                    headerText={
                      <span>
                        <strong>{ev.kind.toUpperCase()}</strong> ·{' '}
                        <span style={{ color: '#687078' }}>
                          {new Date(ev.created_at).toLocaleTimeString()}
                        </span>
                      </span>
                    }
                  >
                    {(ev.kind === 'thinking' || ev.kind === 'reasoning') && ev.payload?.summary ? (
                      <Markdown content={ev.payload.summary} />
                    ) : (
                      <pre style={{ margin: 0, overflowX: 'auto', fontSize: '12px' }}>
                        {JSON.stringify(ev.payload, null, 2)}
                      </pre>
                    )}
                  </ExpandableSection>
                ))}
              </SpaceBetween>
            </Container>

            {selectedExecution.logs && selectedExecution.logs.length > 0 && (
              <Container header={<Header variant="h3">Audit Logs</Header>}>
                <SpaceBetween size="xs">
                  {selectedExecution.logs.map((log) => (
                    <Box key={log.id} fontSize="body-s">
                      <strong>{log.action}</strong> ·{' '}
                      <span style={{ color: '#687078' }}>
                        {new Date(log.created_at).toLocaleTimeString()}
                      </span>
                      {log.details && (
                        <pre style={{ margin: '4px 0 0 0', overflowX: 'auto', fontSize: '11px' }}>
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      )}
                    </Box>
                  ))}
                </SpaceBetween>
              </Container>
            )}
          </SpaceBetween>
        </Modal>
      )}
    </SpaceBetween>
  );
};
