import {createContext,useContext} from 'react';
import type { AgentEvent } from './contracts';

const endpoints: Record<string, string | undefined> = {
  auth: import.meta.env.VITE_AUTH_URL,
  admin: import.meta.env.VITE_ADMIN_API_URL,
  chat: import.meta.env.VITE_CHAT_API_URL,
};

export type AuthMode = 'human' | 'api-token';

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface RequestAuthOptions {
  authMode?: AuthMode;
  onUnauthorized?: (error: ApiError) => void;
}

export const ClientTransportContext = createContext<{
  authMode: AuthMode;
  onUnauthorized?: (error: ApiError) => void;
}>({ authMode: 'human' });

export function useClientTransport() {
  return useContext(ClientTransportContext);
}

export function configuredApiDestinations() {
  return {
    auth: endpoints.auth ? endpoints.auth.replace(/\/$/, '') : '/api/auth',
    chat: endpoints.chat ? endpoints.chat.replace(/\/$/, '') : '/api/chat',
    admin: endpoints.admin ? endpoints.admin.replace(/\/$/, '') : '/api/admin',
  };
}

export function apiUrl(path: string): string {
  const match = /^\/api\/(auth|admin|chat)(\/.*)$/.exec(path);
  if (!match) throw new Error('Invalid API path.');
  const base = endpoints[match[1]];
  return base ? `${base.replace(/\/$/, '')}${match[2]}` : path;
}

let activeTokenRefresher: (() => Promise<string | null>) | null = null;
let latestToken = '';

export function registerTokenRefresher(fn: () => Promise<string | null>) {
  activeTokenRefresher = fn;
}

export function setLatestToken(tok: string) {
  latestToken = tok;
}

async function parseApiError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as {
    error?: { message?: string; code?: string; request_id?: string };
    detail?: string;
  };
  const message =
    body.error?.message ||
    (typeof body.detail === 'string' ? body.detail : '') ||
    `Request failed (${response.status}).`;
  return new ApiError(message, response.status, body.error?.code, body.error?.request_id);
}

export async function api<T>(
  path: string,
  token: string,
  options: RequestInit = {},
  authOptions: RequestAuthOptions = {},
): Promise<T> {
  const apiTokenMode = authOptions.authMode === 'api-token';
  const effectiveToken = apiTokenMode ? token : token || latestToken;
  const credentialsConfig: Pick<RequestInit, 'credentials'> = apiTokenMode
    ? { credentials: 'omit' }
    : path.startsWith('/api/auth/')
      ? { credentials: 'include' }
      : {};

  let response = await fetch(apiUrl(path), {
    ...options,
    ...credentialsConfig,
    headers: {
      ...(effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (
    !apiTokenMode &&
    response.status === 401 &&
    activeTokenRefresher &&
    !path.includes('/portal-session')
  ) {
    const refreshed = await activeTokenRefresher();
    if (refreshed) {
      latestToken = refreshed;
      response = await fetch(apiUrl(path), {
        ...options,
        ...credentialsConfig,
        headers: {
          Authorization: `Bearer ${refreshed}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    }
  }

  if (!response.ok) {
    const apiError = await parseApiError(response);
    if (apiTokenMode && response.status === 401 && !options.signal?.aborted) {
      authOptions.onUnauthorized?.(apiError);
    }
    throw apiError;
  }
  return response.json() as Promise<T>;
}

export async function stream(
  path: string,
  token: string,
  body: unknown,
  receive: (event: AgentEvent) => void,
  signal?: AbortSignal,
  authOptions: RequestAuthOptions = {},
) {
  const apiTokenMode = authOptions.authMode === 'api-token';
  let effectiveToken = apiTokenMode ? token : token || latestToken;
  let response = await fetch(apiUrl(path), {
    method: 'POST',
    ...(apiTokenMode ? { credentials: 'omit' as const } : {}),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectiveToken}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (
    !apiTokenMode &&
    response.status === 401 &&
    activeTokenRefresher &&
    !path.includes('/portal-session')
  ) {
    const refreshed = await activeTokenRefresher();
    if (refreshed) {
      latestToken = refreshed;
      effectiveToken = refreshed;
      response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${effectiveToken}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    }
  }

  if (!response.ok) {
    const apiError = await parseApiError(response);
    if (apiTokenMode && response.status === 401 && !signal?.aborted) {
      authOptions.onUnauthorized?.(apiError);
    }
    throw apiError;
  }
  if (!response.body) throw new ApiError('Streaming is unavailable in this browser.', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split('\n');
        const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (
          type &&
          data &&
          ['execution', 'progress', 'thinking', 'tool', 'cards', 'question', 'result', 'error', 'done'].includes(type)
        ) {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === 'object') receive({ type, data: parsed } as AgentEvent);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const safeHref=(url:string)=>url.startsWith('https://')?url:undefined;

export function portalUrl(portal:'chat'|'admin') {
  return portal==='chat'?(import.meta.env.VITE_CHAT_WEB_URL||'/'):(import.meta.env.VITE_ADMIN_WEB_URL||'/admin/');
}
export function redirectToChat(){window.location.replace(portalUrl('chat'));}
