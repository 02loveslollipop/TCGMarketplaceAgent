import {useState} from 'react';
import {Alert, Button, Container, ContentLayout, Header, SpaceBetween} from '@cloudscape-design/components';
import {api} from './client';

const fields = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'];

export function tcgAuthorizationRequest() {
  const query = new URLSearchParams(window.location.search);
  if (query.get('response_type') !== 'code' || !query.get('client_id')?.startsWith('tcg-')) return null;
  return Object.fromEntries(fields.map(field => [field, query.get(field) ?? '']));
}

export function TcgAuthorization({request, token, username}: {
  request: Record<string, string>;
  token: string;
  username: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nativeCallback, setNativeCallback] = useState('');

  async function continueToTcg() {
    setLoading(true);
    setError('');
    try {
      const result = await api<{redirect_uri: string}>('/api/auth/oauth2/authorize', token, {
        method: 'POST',
        body: JSON.stringify(request),
      });
      if (/^https?:\/\//.test(result.redirect_uri)) {
        window.location.replace(result.redirect_uri);
      } else {
        // Mobile browsers require a direct user gesture to open the app's URL scheme.
        setNativeCallback(result.redirect_uri);
        setLoading(false);
      }
    } catch {
      setError('Could not authorize this request. Open TCG Manager and start sign-in again.');
      setLoading(false);
    }
  }

  return <ContentLayout header={<Header variant="h1">Sign in to TCG Manager</Header>}>
    <Container>
      <SpaceBetween size="m">
        {error && <Alert type="error">{error}</Alert>}
        <div>Continue with your shared account, {username}.</div>
        {nativeCallback
          ? <Button variant="primary" href={nativeCallback}>Open TCG Manager</Button>
          : <Button variant="primary" loading={loading} onClick={() => void continueToTcg()}>Continue</Button>}
      </SpaceBetween>
    </Container>
  </ContentLayout>;
}
