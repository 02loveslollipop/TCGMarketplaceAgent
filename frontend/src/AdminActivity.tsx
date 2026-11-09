import React, { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import Modal from '@cloudscape-design/components/modal';
import Alert from '@cloudscape-design/components/alert';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import TextFilter from '@cloudscape-design/components/text-filter';
import Pagination from '@cloudscape-design/components/pagination';
import { api } from './client';
import { AdminExecutionDetail, AdminExecutionSummary, LegalityStatus } from './contracts';
import { Markdown } from './Markdown';

interface AdminActivityProps {
  token: string;
}

export const AdminActivity: React.FC<AdminActivityProps> = ({ token }) => {
  const [executions, setExecutions] = useState<AdminExecutionSummary[]>([]);
  const [legality, setLegality] = useState<LegalityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingLegality, setRefreshingLegality] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedExecution, setSelectedExecution] = useState<AdminExecutionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

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
    setLoadingDetail(true);
    try {
      const detail = await api<AdminExecutionDetail>(`/api/admin/activity/${executionId}`, token);
      setSelectedExecution(detail);
    } catch (err: any) {
      setError(err.message || 'Failed to load execution detail.');
    } finally {
      setLoadingDetail(false);
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

  return (
    <SpaceBetween size="l">
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Legality Catalog Card */}
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

      {/* Execution & Reasoning Trace Table */}
      <Table
        loading={loading}
        loadingText="Loading executions and reasoning logs..."
        items={paged}
        header={
          <Header
            variant="h2"
            description="Inspect agent model reasoning traces, tool executions, and step-by-step activity history."
            actions={
              <Button iconName="refresh" onClick={loadData}>
                Refresh
              </Button>
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
              <StatusIndicator
                type={
                  e.status === 'complete'
                    ? 'success'
                    : e.status === 'running'
                    ? 'loading'
                    : e.status === 'failed'
                    ? 'error'
                    : 'stopped'
                }
              >
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
                loading={loadingDetail}
                onClick={() => handleViewDetail(e.id)}
              >
                View reasoning &amp; trace
              </Button>
            ),
          },
        ]}
      />

      {/* Detail Modal */}
      {selectedExecution && (
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
                <StatusIndicator
                  type={selectedExecution.status === 'complete' ? 'success' : 'info'}
                >
                  {selectedExecution.status}
                </StatusIndicator>
              </div>
              <div>
                <Box color="text-body-secondary">Timestamp</Box>
                <Box>{new Date(selectedExecution.created_at).toLocaleString()}</Box>
              </div>
            </ColumnLayout>

            {/* Reasoning Summary Section */}
            {selectedExecution.reasoning_summary ? (
              <Container header={<Header variant="h3">Model Reasoning Trace</Header>}>
                <Markdown content={selectedExecution.reasoning_summary} />
              </Container>
            ) : null}

            {/* Events and Tool Calls */}
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
