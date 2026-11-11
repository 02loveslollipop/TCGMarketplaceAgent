import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Markdown } from '../Markdown';
import { ThinkingTrace } from '../ThinkingTrace';
import type { ChatEntry } from '../ChatActivity';

it('renders GFM markdown pipe tables with headers and aligned cells', () => {
  const tableMarkdown = `
Here is a comparison table:

| Card Name | Role | Market Price |
| :--- | :---: | ---: |
| M Lucario EX | Main Attacker | $12.50 |
| Strong Energy | Special Energy | $3.20 |
| Korrina | Supporter | $1.80 |

End of table.
`;

  const { container } = render(<Markdown text={tableMarkdown} />);
  const table = container.querySelector('table.chat-markdown-table');
  expect(table).toBeInTheDocument();

  const headers = container.querySelectorAll('th');
  expect(headers).toHaveLength(3);
  expect(headers[0].textContent).toBe('Card Name');
  expect(headers[1].textContent).toBe('Role');
  expect(headers[2].textContent).toBe('Market Price');

  const rows = container.querySelectorAll('tbody tr');
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain('M Lucario EX');
  expect(rows[0].textContent).toContain('Main Attacker');
  expect(rows[0].textContent).toContain('$12.50');
});

it('renders tool calls in ThinkingTrace with tool name, duration, and verified source pills', () => {
  const entries: ChatEntry[] = [
    {
      id: 'tool-entry-1',
      type: 'tool',
      data: {
        id: 't-1',
        name: 'quote_supplier',
        status: 'complete',
        input: { supplier: 'TCGplayer', card_id: 'me01-076' },
        duration_ms: 180,
        sources: [
          { url: 'https://www.tcgplayer.com/product/654415', title: 'TCGplayer Product Listing' },
        ],
      },
    },
    {
      id: 'thinking-entry-1',
      type: 'thinking',
      data: {
        id: 'th-1',
        source: 'approach_summary',
        status: 'complete',
        summary: 'Resolved 60 cards across standard format sets.',
      },
    },
  ];

  render(<ThinkingTrace entries={entries} active={false} />);
  expect(screen.getByTestId('thinking-trace')).toBeInTheDocument();

  // Find tool call component
  const toolCall = screen.getByTestId('thinking-tool-call');
  expect(toolCall).toBeInTheDocument();
  expect(toolCall.textContent).toContain('Quote TCGplayer');
  expect(toolCall.textContent).toContain('180 ms');
  expect(toolCall.textContent).toContain('me01-076');

  // Verify source pill
  const sourceLink = screen.getByRole('link', { name: 'TCGplayer Product Listing' });
  expect(sourceLink).toBeInTheDocument();
  expect(sourceLink).toHaveAttribute('href', 'https://www.tcgplayer.com/product/654415');
});
