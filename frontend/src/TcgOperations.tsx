import {useEffect, useState} from 'react';
import {Alert, Button, Container, Header, KeyValuePairs, SpaceBetween, StatusIndicator} from '@cloudscape-design/components';
import {api} from './client';

interface Overview {
  catalog_printings: number;
  inventory_printings: number;
  decks: number;
  wishlist_entries: number;
  price_observations: number;
  last_price_success: string | null;
  can_refresh: boolean;
}

export function TcgOperations({token}: {token: string}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const webUrl = import.meta.env.VITE_TCG_MANAGER_WEB_URL;

  useEffect(() => {
    const controller = new AbortController();
    void api<Overview>('/api/admin/tcg-manager/overview', token, {signal: controller.signal})
      .then(setOverview)
      .catch(problem => {if (!controller.signal.aborted) setError(problem.message);});
    return () => controller.abort();
  }, [token]);

  async function refreshNext() {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{status: string}>('/api/admin/tcg-manager/prices/refresh-next', token, {method: 'POST'});
      const messages: Record<string, string> = {
        up_to_date: 'All tracked printings are up to date.',
        available: 'Price references updated.',
        unavailable: 'No USD price references were available for this printing.',
        provider_error: 'The price provider could not be reached. The next scheduled run will retry.',
      };
      setNotice(messages[result.status] ?? result.status);
      setOverview(await api<Overview>('/api/admin/tcg-manager/overview', token));
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return <SpaceBetween size="l">
    <Header variant="h1" actions={webUrl && <Button href={webUrl}>Open TCG Manager</Button>}>TCG Manager</Header>
    {error && <Alert type="error">{error}</Alert>}
    {notice && <Alert type="info">{notice}</Alert>}
    {!overview && !error && <StatusIndicator type="loading">Loading operations</StatusIndicator>}
    {overview && <Container header={<Header variant="h2" actions={overview.can_refresh &&
      <Button loading={working} onClick={() => void refreshNext()}>Refresh next due price</Button>
    }>Collection and pricing</Header>}>
      <KeyValuePairs columns={3} items={[
        {label: 'Catalog printings', value: overview.catalog_printings.toLocaleString()},
        {label: 'Inventory printings', value: overview.inventory_printings.toLocaleString()},
        {label: 'Decks', value: overview.decks.toLocaleString()},
        {label: 'Wishlist entries', value: overview.wishlist_entries.toLocaleString()},
        {label: 'Price observations', value: overview.price_observations.toLocaleString()},
        {label: 'Latest successful price check', value: overview.last_price_success ?
          new Date(overview.last_price_success).toLocaleString() : 'Pending'},
      ]}/>
    </Container>}
  </SpaceBetween>;
}
