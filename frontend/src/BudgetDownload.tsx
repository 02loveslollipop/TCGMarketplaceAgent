import { useState } from 'react';
import {
  Alert,
  Button,
  LiveRegion,
  SpaceBetween,
} from '@cloudscape-design/components';
import type { Result } from './contracts';

export function BudgetDownload({ result }: { result: Result }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  async function download() {
    if (busy) return;
    setBusy(true);
    setError('');
    setAnnouncement('');
    try {
      const { downloadBudgetExcel } = await import('./budgetExcel');
      await downloadBudgetExcel(result);
      setAnnouncement('Excel budget download started.');
    } catch {
      setError('The Excel export could not be created. Try downloading again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SpaceBetween size="xs">
      <Button
        formAction="none"
        iconName="download"
        loading={busy}
        loadingText="Preparing Excel export"
        onClick={() => void download()}
      >
        Download Excel
      </Button>
      <LiveRegion hidden>{announcement}</LiveRegion>
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError('')}>
          {error}
        </Alert>
      )}
    </SpaceBetween>
  );
}
