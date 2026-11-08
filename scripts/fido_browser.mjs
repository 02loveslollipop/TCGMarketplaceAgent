// Drive only the PoC tab in the dedicated headed Chrome window.
// Read the generated local password privately; never put it in CLI arguments,
// snapshots, logs or screenshots. Native authenticator prompts stay with the user.
import {readFile} from 'node:fs/promises';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';

const base = 'http://localhost:8080';
const mode = process.argv[2] || 'status';
try {
  if (!['status', 'login'].includes(mode)) throw new Error('Unsupported mode');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url() === `${base}/`) || await context.newPage();
  if (!page.url().startsWith(base)) await page.goto(`${base}/`);
  if (mode === 'login') {
    const credentials = JSON.parse(await readFile(new URL('../.runtime/bootstrap-admin.json', import.meta.url), 'utf8'));
    await page.getByRole('textbox', {name: 'Username', exact: true}).fill(credentials.username);
    await page.getByLabel('Password', {exact: true}).fill(credentials.password);
    const response = page.waitForResponse(r => r.url() === `${base}/api/auth/token` && r.request().method() === 'POST');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    const result = await response;
    const body = await result.json();
    console.log(JSON.stringify({password_status: result.status(), second_factor_required: Boolean(body.challenge_token), access_token_issued: Boolean(body.access_token)}));
    if (body.access_token) await page.getByRole('heading', {name: 'Pokémon deck agent', exact: true}).waitFor();
  }
  const result = {
    app_tab: page.url() === `${base}/`,
    authenticated: await page.getByRole('button', {name: 'Sign out', exact: true}).isVisible(),
    webauthn_supported: await page.evaluate(() => isSecureContext && 'PublicKeyCredential' in window),
  };
  console.log(JSON.stringify(result));
  // The externally launched browser must remain open for physical user actions.
  process.exit(0);
} catch (error) {
  // Playwright error messages may include input values: expose only the type.
  console.log(JSON.stringify({passed: false, error_type: error.name}));
  process.exit(1);
}
