import {Box, ExpandableSection, SpaceBetween, StatusIndicator} from '@cloudscape-design/components';
import type {ChatEntry} from './ChatActivity';
import type {AgentEvent} from './contracts';
import {Markdown} from './Markdown';

function toolTitle(data: { name: string; input?: Record<string, any> }): string {
  switch (data.name) {
    case 'search_cards': return 'Search card database';
    case 'get_card': return 'Retrieve card details';
    case 'get_cards': return 'Batch retrieve cards';
    case 'query_tcgdex_graphql': return 'Query TCGdex GraphQL';
    case 'search_deck_lists': return 'Search decklists';
    case 'get_deck_list': return 'Retrieve decklist';
    case 'quote_supplier': return `Quote ${data.input?.supplier || 'supplier'}`;
    case 'current_legality': return 'Check tournament format legality';
    default: return data.name;
  }
}

export function ThinkingTrace({entries, active}:{entries: ChatEntry[]; active: boolean}) {
  const items = entries.filter((entry): entry is ChatEntry & (Extract<AgentEvent, {type: 'thinking'}> | Extract<AgentEvent, {type: 'tool'}>) => {
    if (entry.type === 'thinking') return Boolean(entry.data?.summary?.trim());
    if (entry.type === 'tool') return Boolean(entry.data?.name);
    return false;
  });

  if (!items.length) return null;

  const failed = items.some(entry => entry.data.status === 'error');
  const interrupted = !active && items.some(entry => entry.data.status === 'loading' || entry.data.status === 'error');
  const label = active ? 'Thinking' : interrupted ? 'Thinking interrupted' : 'Completed thinking';
  const statusType = active ? 'loading' : failed ? 'error' : interrupted ? 'stopped' : 'info';

  return (
    <div className="chat-thinking-trace" data-testid="thinking-trace">
      <ExpandableSection
        defaultExpanded={false}
        headerText={<StatusIndicator type={statusType}>{label}</StatusIndicator>}
      >
        <div className="chat-thinking-body">
          <SpaceBetween size="s">
            {items.map(entry => {
              if (entry.type === 'thinking') {
                const isProvider = entry.data.source === 'provider_summary';
                return (
                  <div key={entry.id} className="chat-thinking-item">
                    <Box fontWeight="bold">
                      {isProvider ? 'Model reasoning summary' : 'Approach summary'}
                    </Box>
                    <div className="chat-message-text">
                      <Markdown text={entry.data.summary} />
                    </div>
                    {(entry.data.status === 'error' || (entry.data.status === 'loading' && !active)) && (
                      <StatusIndicator type={entry.data.status === 'error' ? 'error' : 'stopped'}>
                        Summary interrupted
                      </StatusIndicator>
                    )}
                    {entry.data.status === 'loading' && active && (
                      <StatusIndicator type="loading">Generating thoughts...</StatusIndicator>
                    )}
                  </div>
                );
              }

              const toolData = entry.data;
              const toolStatus = toolData.status === 'error' ? 'error' : toolData.status === 'loading' ? 'loading' : 'success';
              const inputEntries = Object.entries(toolData.input || {}).filter(([_, v]) => v !== undefined && v !== '');

              return (
                <div key={entry.id} className="chat-thinking-tool" data-testid="thinking-tool-call">
                  <div className="chat-thinking-tool-header">
                    <StatusIndicator type={toolStatus}>
                      <span className="chat-tool-name">{toolTitle(toolData)}</span>
                    </StatusIndicator>
                    {toolData.duration_ms !== undefined && toolData.duration_ms !== null && (
                      <span className="chat-tool-duration">{toolData.duration_ms} ms</span>
                    )}
                  </div>
                  {inputEntries.length > 0 && (
                    <div className="chat-tool-inputs">
                      {inputEntries.map(([k, v]) => (
                        <span key={k} className="chat-tool-param">
                          <strong>{k}:</strong> {String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                  {toolData.sources && toolData.sources.length > 0 && (
                    <div className="chat-tool-sources">
                      <span className="chat-tool-sources-label">Sources:</span>
                      {toolData.sources.map((src, sIdx) => (
                        <a
                          key={sIdx}
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="chat-tool-source-pill"
                        >
                          {src.title || src.url}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </SpaceBetween>
        </div>
      </ExpandableSection>
    </div>
  );
}
