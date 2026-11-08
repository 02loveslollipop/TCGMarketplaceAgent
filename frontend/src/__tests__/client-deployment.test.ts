import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('deployment API routing', () => {
  it('routes each API to its configured service and preserves endpoint paths', async () => {
    vi.stubEnv('VITE_AUTH_URL', 'https://auth.example.test/');
    vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.test');
    vi.stubEnv('VITE_CHAT_API_URL', 'https://chat.example.test');
    const {apiUrl} = await import('../client');
    expect(apiUrl('/api/auth/token')).toBe('https://auth.example.test/token');
    expect(apiUrl('/api/admin/accounts')).toBe('https://admin.example.test/accounts');
    expect(apiUrl('/api/chat/executions/abc/resume')).toBe('https://chat.example.test/executions/abc/resume');
    expect(() => apiUrl('https://evil.example.test/')).toThrow();
  });

  it('keeps local gateway paths when no service URLs are configured', async () => {
    vi.stubEnv('VITE_AUTH_URL', '');
    const {apiUrl} = await import('../client');
    expect(apiUrl('/api/auth/token')).toBe('/api/auth/token');
  });
});
