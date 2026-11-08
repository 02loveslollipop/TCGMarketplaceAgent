// Targeted real-browser verification for the reference-inspired login revision.
// Secrets are read in memory and never appear in arguments, output or screenshots.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';

const base = 'http://localhost:8080';
const credentials = JSON.parse(await readFile(new URL('../.runtime/bootstrap-admin.json', import.meta.url), 'utf8'));
const output = new URL('../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage();
let phase = 'desktop_layout';
const checks = [];
const activeTokens = new Set();
const runtimeErrors = [];
page.on('pageerror', error => runtimeErrors.push(error.name));
const passed = check => { checks.push(check); console.log(JSON.stringify({ check, passed: true })); };

async function layout(path, viewport, stacked, screenshot) {
  await page.setViewportSize(viewport);
  await page.goto(`${base}${path}`);
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const bounds = await page.evaluate(() => {
    const rectangle = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    return { main: rectangle('.login-page'), visual: rectangle('.login-visual'), panel: rectangle('.login-panel'),
      card: rectangle('.login-card'), width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth };
  });
  assert(bounds.main.height >= bounds.height - 1);
  assert(bounds.scrollWidth <= bounds.width + 1);
  assert(bounds.card.width <= 461 && bounds.card.right <= bounds.width + 1);
  if (stacked) {
    assert(bounds.panel.y >= bounds.visual.bottom - 1);
    assert(bounds.visual.width >= bounds.width - 1);
  } else {
    assert(bounds.panel.x >= bounds.visual.right - 1);
    assert(Math.abs(bounds.visual.width / bounds.width - 2 / 3) < 0.03);
  }
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), false);
  if (screenshot) await page.screenshot({ path: new URL(screenshot, output).pathname, fullPage: true });
  passed(`${path === '/' ? 'Chat' : 'Admin'} login ${viewport.width}px ${stacked ? 'stacked' : 'split'} layout`);
}

async function signIn(expectedHeading) {
  const username = page.getByRole('textbox', { name: 'Username', exact: true });
  const password = page.getByLabel('Password', { exact: true });
  await username.fill(credentials.username);
  await username.focus();
  await page.keyboard.press('Tab');
  assert(await password.evaluate(element => element === document.activeElement));
  await password.fill(credentials.password);
  const response = page.waitForResponse(r => r.url() === `${base}/api/auth/token` && r.request().method() === 'POST');
  await password.press('Enter');
  const result = await response;
  assert.equal(result.status(), 200);
  const token = (await result.json()).access_token;
  assert(token);
  activeTokens.add(token);
  await page.getByRole('heading', { name: expectedHeading, exact: true }).waitFor();
  passed(`Keyboard-based actual login to ${expectedHeading}`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  passed('Sign-out returns to the reference-inspired login');
}

try {
  await layout('/', { width: 1440, height: 1000 }, false, 'login-redesign-desktop.png');
  phase = 'invalid_credentials';
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('unrecognized-layout-check');
  await page.getByLabel('Password', { exact: true }).fill('invalid-verification-password');
  const denied = page.waitForResponse(r => r.url() === `${base}/api/auth/token` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.equal((await denied).status(), 401);
  passed('Unknown credentials rejected with HTTP 401');
  await page.getByText('Unable to sign in', { exact: true }).waitFor();
  await page.getByText('Invalid credentials.', { exact: true }).waitFor();
  passed('Invalid credentials remain on the login with an explanatory error');
  phase = 'actual_chat_login';
  await signIn('Pokémon deck agent');
  phase = 'mobile_layout';
  await layout('/', { width: 390, height: 844 }, true, 'login-redesign-mobile.png');
  await layout('/', { width: 320, height: 740 }, true, null);
  await layout('/admin/', { width: 390, height: 844 }, true, 'admin-login-redesign-mobile.png');
  phase = 'actual_admin_login';
  await signIn('Agent administration');
  phase = 'admin_desktop_layout';
  await layout('/admin/', { width: 1440, height: 1000 }, false, 'admin-login-redesign-desktop.png');
  assert.equal(runtimeErrors.length, 0);
  passed('No browser runtime exceptions');
} catch (error) {
  // Assertion/Playwright messages can include field values: log only safe metadata.
  await page.screenshot({ path: new URL('login-redesign-check-failure.png', output).pathname, fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ check: 'login_visual_check', passed: false, phase, error_type: error.name }));
  process.exitCode = 1;
} finally {
  for (const token of activeTokens) {
    try { await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch { /* No secret output. */ }
  }
  await browser.close();
  console.log(JSON.stringify({ completed_checks: checks.length, artifacts: 'output/playwright/' }));
}
