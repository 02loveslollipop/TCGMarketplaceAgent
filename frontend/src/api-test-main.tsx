import React from 'react';
import ReactDOM from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import './dark-blue.css';
import {initializeAppearance} from './appearance';
import {ApiTokenShell} from './ApiTokenShell';

initializeAppearance();
const bootstrapToken = import.meta.env.VITE_API_TEST_BOOTSTRAP === 'true' ? async () => {
  const response = await fetch('/api-test/bootstrap', {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: {'Content-Type': 'application/json'}, body: '{}',
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error('Launch token unavailable.');
  const value = await response.json();
  if (typeof value.token !== 'string') throw new Error('Invalid launch token.');
  return value.token;
} : undefined;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApiTokenShell bootstrapToken={bootstrapToken} />
  </React.StrictMode>,
);
