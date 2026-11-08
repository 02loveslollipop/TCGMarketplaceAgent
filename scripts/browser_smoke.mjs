// Real browser smoke; generated credentials stay in process memory and a private file.
// No passwords, JWTs, request headers or login response bodies are logged.
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';

const base = 'http://localhost:8080';
const credentials = JSON.parse(await readFile(new URL('../.runtime/bootstrap-admin.json', import.meta.url), 'utf8'));
const artifacts = new URL('../output/playwright/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let phase = 'login', adminToken, webToken, previousPolicy;
const checks = [];
const report = (name) => { checks.push(name); console.log(JSON.stringify({ check: name, passed: true })); };

async function login(url) {
  await page.goto(url);
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  const response = page.waitForResponse(r => r.url() === `${base}/api/auth/token` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const tokenResponse = await response;
  if (tokenResponse.status() !== 200) throw new Error('Unexpected authentication status');
  const token = (await tokenResponse.json()).access_token;
  await page.getByText(`Signed in as ${credentials.username}`, { exact: true }).waitFor();
  return token;
}

async function api(path, token, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`API status ${response.status}`);
  return response.json();
}

try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.screenshot({ path: new URL('login.png', artifacts).pathname, fullPage: true });
  report('Cloudscape login page');

  adminToken = await login(`${base}/admin/`);
  await page.getByRole('heading', { name: 'Agent administration', exact: true }).waitFor();
  report('Actual administrator login and portal');
  const policies = await api('/api/admin/models', adminToken);
  previousPolicy = policies.find(p => p.id === 'gpt-6-luna');
  if (!previousPolicy) throw new Error('Requested model preset missing');
  phase = 'model_administration';
  await page.getByRole('button', { name: 'Edit GPT 6 luna', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enabled for agent use', exact: true }).check();
  const save = page.waitForResponse(r => r.url() === `${base}/api/admin/models/gpt-6-luna` && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save model policy', exact: true }).click();
  if ((await save).status() !== 200) throw new Error('Model policy update failed');
  await page.getByText('Model policy saved.', { exact: true }).waitFor();
  await page.screenshot({ path: new URL('admin.png', artifacts).pathname, fullPage: true });
  report('Cloudscape model policy verified and enabled via UI');

  phase = 'streamed_chat';
  webToken = await login(base);
  await page.getByTestId('model-select').getByText('GPT 6 luna', { exact: true }).waitFor();
  await page.getByTestId('chat-prompt-textarea').fill('Make a M Gardevoir EX deck');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('heading', { name: 'Clarification', exact: true }).waitFor({ timeout: 240000 });
  await page.getByTestId('decision-cancel-button').waitFor({ state: 'visible' });
  await page.screenshot({ path: new URL('chat-clarification.png', artifacts).pathname, fullPage: true });
  report('Real model LangGraph clarification streamed into Cloudscape');
  const conversations = await api('/api/chat/conversations', webToken);
  const conversation = conversations.find(c => c.title === 'Make a M Gardevoir EX deck');
  if (!conversation) throw new Error('Conversation not persisted');
  const history = await api(`/api/chat/conversations/${conversation.id}`, webToken);
  if (!history.some(message => message.role === 'assistant' && message.content?.type === 'question')) throw new Error('Question not persisted');
  report('PostgreSQL conversation and clarification persistence');

  phase = 'history_restore';
  webToken = await login(base);
  await page.getByTestId('conversation-select').locator('button').first().click();
  await page.getByRole('option').filter({ hasText: 'Make a M Gardevoir EX deck' }).first().click();
  await page.getByRole('heading', { name: 'Clarification', exact: true }).waitFor();
  report('Cloudscape history restores pending decision after new login');
  const cancelResponse = page.waitForResponse(r => r.url().includes('/resume') && r.request().method() === 'POST');
  await page.getByTestId('decision-cancel-button').click();
  if ((await cancelResponse).status() !== 200) throw new Error('Cancellation failed');
  await page.getByTestId('chat-prompt-textarea').waitFor();
  report('Authenticated pending execution cancellation');
} catch (error) {
  // Playwright errors can echo fill() arguments: never print message/stack here.
  console.log(JSON.stringify({ check: 'browser_smoke', passed: false, phase, error_type: error.name }));
  process.exitCode = 1;
} finally {
  if (adminToken && previousPolicy) {
    try {
      await api(`/api/admin/models/${previousPolicy.id}`, adminToken, 'PUT', {
        label: previousPolicy.label, provider: previousPolicy.provider, api_id: previousPolicy.api_id, enabled: previousPolicy.enabled,
      });
      report('Previous model policy restored');
    } catch (error) {
      console.log(JSON.stringify({ check: 'model_policy_restore', passed: false, error_type: error.name }));
      process.exitCode = 1;
    }
  }
  if (webToken || adminToken) {
    try { await api('/api/auth/logout', webToken || adminToken, 'POST'); } catch { /* No secret-bearing error output. */ }
  }
  await browser.close();
  console.log(JSON.stringify({ completed_checks: checks.length, artifacts: 'output/playwright/' }));
}
