import React from 'react';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import Table from '@cloudscape-design/components/table';

interface MarkdownProps {
  content?: string;
  text?: string;
}

function renderInline(text: string): React.ReactNode[] {
  // Regex to split on bold, inline code, and links
  const tokens: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <Box key={match.index} variant="code">
          {token.slice(1, -1)}
        </Box>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      tokens.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const splitIdx = token.indexOf('](');
      const label = token.slice(1, splitIdx);
      const url = token.slice(splitIdx + 2, -1);
      const isHttp = url.startsWith('http://') || url.startsWith('https://');
      tokens.push(
        isHttp ? (
          <Link key={match.index} href={url} external>
            {label}
          </Link>
        ) : (
          <span key={match.index}>{label}</span>
        )
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

export const Markdown: React.FC<MarkdownProps> = ({ content, text }) => {
  const value = content ?? text ?? '';
  if (!value) return null;

  const rawLines = value.split('\n');
  const blocks: React.ReactNode[] = [];
  let currentList: { type: 'ul' | 'ol'; items: React.ReactNode[] } | null = null;

  const flushList = () => {
    if (currentList) {
      if (currentList.type === 'ul') {
        blocks.push(
          <ul key={`list-${blocks.length}`} style={{ margin: '4px 0', paddingLeft: '20px' }}>
            {currentList.items.map((it, idx) => (
              <li key={idx}>{it}</li>
            ))}
          </ul>
        );
      } else {
        blocks.push(
          <ol key={`list-${blocks.length}`} style={{ margin: '4px 0', paddingLeft: '20px' }}>
            {currentList.items.map((it, idx) => (
              <li key={idx}>{it}</li>
            ))}
          </ol>
        );
      }
      currentList = null;
    }
  };

  function isTableSeparator(line: string): boolean {
    return /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?::?-{2,}:?\s*)?$/.test(line);
  }

  function splitTableCells(line: string): string[] {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  }

  function parseAlignments(separatorLine: string): ('left' | 'center' | 'right')[] {
    const cells = splitTableCells(separatorLine);
    return cells.map(cell => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      continue;
    }

    // Table check: line has '|' and next line is table separator
    if (trimmed.includes('|') && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1])) {
      flushList();
      const headers = splitTableCells(trimmed);
      const alignments = parseAlignments(rawLines[i + 1]);
      i += 1; // advance past separator
      const rows: string[][] = [];
      while (i + 1 < rawLines.length) {
        const nextLine = rawLines[i + 1].trim();
        if (!nextLine || !nextLine.includes('|') || isTableSeparator(nextLine)) break;
        i += 1;
        rows.push(splitTableCells(nextLine));
      }
      blocks.push(
        <Table<string[]> key={`table-${i}`} variant="embedded" wrapLines
          ariaLabels={{tableLabel:'Response table'}}
          items={rows}
          columnDefinitions={headers.map((header,index)=>({
            id:`column-${index}`,header:<Box textAlign={(alignments[index]||'left') as 'left'|'center'|'right'}>{renderInline(header)}</Box>,
            cell:row=><Box textAlign={(alignments[index]||'left') as 'left'|'center'|'right'}>{renderInline(row[index]??'')}</Box>,
          }))}/>
      );
      continue;
    }

    if (trimmed.startsWith('### ')) {
      flushList();
      blocks.push(
        <Box key={`h3-${i}`} variant="h3" margin={{ top: 's', bottom: 'xs' }}>
          {renderInline(trimmed.slice(4))}
        </Box>
      );
      continue;
    }

    if (trimmed.startsWith('## ')) {
      flushList();
      blocks.push(
        <Box key={`h2-${i}`} variant="h2" margin={{ top: 'm', bottom: 'xs' }}>
          {renderInline(trimmed.slice(3))}
        </Box>
      );
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flushList();
      blocks.push(
        <Box key={`h1-${i}`} variant="h1" margin={{ top: 'm', bottom: 'xs' }}>
          {renderInline(trimmed.slice(2))}
        </Box>
      );
      continue;
    }

    // Bullet list: - or *
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!currentList || currentList.type !== 'ul') {
        flushList();
        currentList = { type: 'ul', items: [] };
      }
      currentList.items.push(renderInline(trimmed.slice(2)));
      continue;
    }

    // Numbered list: 1. 2.
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      if (!currentList || currentList.type !== 'ol') {
        flushList();
        currentList = { type: 'ol', items: [] };
      }
      currentList.items.push(renderInline(numMatch[2]));
      continue;
    }

    // Paragraph
    flushList();
    blocks.push(
      <Box key={`p-${i}`} margin={{ bottom: 'xxs' }}>
        {renderInline(trimmed)}
      </Box>
    );
  }

  flushList();

  return <div className="markdown-body">{blocks}</div>;
};
