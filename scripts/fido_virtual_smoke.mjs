// Automated preflight only: this never counts as Google Password Manager or
// physical-key evidence. The headed interactive Chrome window is not touched.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';

const base = 'http://localhost:8080';
const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true});
const context = await browser.newContext();
const page = await context.newPage();
const fixture = {username: `fido-smoke-${randomUUID().slice(0, 12)}`, password: randomBytes(32).toString('base64url')};
let adminToken, fixtureId, phase = 'fixture_setup';
let checks = 0;
const passed = check => { checks++; console.log(JSON.stringify({check, passed: true, authenticator: 'virtual'})); };

async function passwordLogin() {
  await page.getByRole('textbox', {name: 'Username', exact: true}).fill(fixture.username);
  await page.getByLabel('Password', {exact: true}).fill(fixture.password);
  const pending = page.waitForResponse(r => r.url() === `${base}/api/auth/token` && r.request().method() === 'POST');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  return response.json();
}

try {
  const admin = JSON.parse(await readFile(new URL('../.runtime/bootstrap-admin.json', import.meta.url), 'utf8'));
  const auth = await context.request.post(`${base}/api/auth/token`, {form: admin});
  assert.equal(auth.status(), 200);
  adminToken = (await auth.json()).access_token;
  assert(adminToken, 'Run this preflight before interactive administrator enrollment');
  const created = await context.request.post(`${base}/api/auth/accounts`, {
    headers: {Authorization: `Bearer ${adminToken}`}, data: {...fixture, role: 'user'},
  });
  assert.equal(created.status(), 201);
  fixtureId = (await created.json()).id;
  await page.goto(`${base}/`);
  const initial = await passwordLogin();
  assert(initial.access_token);
  await page.getByRole('button', {name: 'Passkeys and security keys', exact: true}).click();
  await page.getByRole('textbox', {name: 'Authenticator name', exact: true}).waitFor();
  passed('Isolated fixture can reach authenticator settings');

  phase = 'registration';
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
    protocol: 'ctap2', transport: 'usb', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  }});
  await page.getByRole('textbox', {name: 'Authenticator name', exact: true}).fill('Virtual preflight');
  const enrollment = page.waitForResponse(r => r.url() === `${base}/api/auth/webauthn/registration/verify`);
  await page.getByRole('button', {name: 'Add passkey or security key', exact: true}).click();
  const enrolled = await enrollment;
  assert.equal(enrolled.status(), 200);
  assert.equal((await enrolled.json()).enrolled, true);
  await page.getByRole('heading', {name: 'Sign in', exact: true}).waitFor();
  const oldSession = await context.request.get(`${base}/api/auth/session`, {headers: {Authorization: `Bearer ${initial.access_token}`}});
  assert.equal(oldSession.status(), 401);
  passed('Actual browser registration verifies and revokes the previous session');

  phase = 'second_factor';
  const pending = await passwordLogin();
  assert(pending.challenge_token);
  assert.equal(Boolean(pending.access_token), false);
  const preAuth = await context.request.get(`${base}/api/auth/session`, {headers: {Authorization: `Bearer ${pending.challenge_token}`}});
  assert.equal(preAuth.status(), 401);
  passed('Password challenge cannot access an authenticated session');
  phase = 'cancel_and_retry';
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {authenticatorId, enabled: false});
  const optionsResponse = page.waitForResponse(r => r.url() === `${base}/api/auth/webauthn/authentication/options`);
  await page.getByRole('button', {name: 'Use passkey or security key', exact: true}).click();
  const cancelledId = (await (await optionsResponse).json()).challenge_id;
  const cancellation = page.waitForResponse(r => r.url() === `${base}/api/auth/webauthn/challenges/${cancelledId}/cancel`);
  await page.getByRole('button', {name: 'Cancel authenticator', exact: true}).click();
  assert.equal((await cancellation).status(), 200);
  await page.getByText('Authenticator operation was cancelled or timed out. You can try again.', {exact: true}).waitFor();
  const replay = await context.request.post(`${base}/api/auth/webauthn/authentication/verify`, {data: {
    challenge_token: pending.challenge_token, challenge_id: cancelledId, credential: {},
  }});
  assert.equal(replay.status(), 401);
  assert.match((await replay.json()).error.message, /consumed/);
  passed('Cancelling the browser ceremony consumes its server challenge and permits a new attempt');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {authenticatorId, enabled: true});
  phase = 'second_factor_retry';
  let racePassed = false;
  await page.route('**/api/auth/webauthn/authentication/verify', async route => {
    try {
      // Race two genuine copies of the browser's signed assertion against the
      // actual PostgreSQL-backed endpoint; return the successful response to UI.
      const data = route.request().postDataJSON();
      const replies = await Promise.all([1, 2].map(() => context.request.post(route.request().url(), {data})));
      const statuses = replies.map(r => r.status()).sort();
      racePassed = statuses[0] === 200 && statuses[1] === 401;
      await route.fulfill({response: replies.find(r => r.status() === 200) || replies[0]});
    } catch {
      await route.abort('failed');
    }
  });
  const verification = page.waitForResponse(r => r.url() === `${base}/api/auth/webauthn/authentication/verify`);
  await page.getByRole('button', {name: 'Use passkey or security key', exact: true}).click();
  const verified = await verification;
  assert.equal(verified.status(), 200);
  const session = await verified.json();
  assert(session.access_token);
  assert.equal(racePassed, true);
  passed('Concurrent replay of the signed browser assertion yields exactly one HTTP 200 and one HTTP 401');
  await page.getByRole('heading', {name: 'Pokémon deck agent', exact: true}).waitFor();
  passed('Actual browser assertion completes password-first second-factor login');
  const credentials = await context.request.get(`${base}/api/auth/webauthn/credentials`, {headers: {Authorization: `Bearer ${session.access_token}`}});
  assert.equal(credentials.status(), 200);
  const rows = await credentials.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Virtual preflight');
  const removal = await context.request.delete(`${base}/api/auth/webauthn/credentials/${rows[0].id}`, {headers: {Authorization: `Bearer ${session.access_token}`}});
  assert.equal(removal.status(), 409);
  passed('Last authenticator cannot be removed without an alternative');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await page.getByRole('heading', {name: 'Sign in', exact: true}).waitFor();
  passed('Second-factor session can sign out');
} catch (error) {
  console.log(JSON.stringify({passed: false, phase, error_type: error.name, authenticator: 'virtual'}));
  process.exitCode = 1;
} finally {
  if (fixtureId) {
    // Use only the auth runtime role and the one account this run created.
    const cleanup = spawnSync('.venv/bin/python', ['-c',
      'import json,sys,psycopg\nfrom dotenv import dotenv_values\nfrom sqlalchemy import create_engine\nfrom sqlalchemy.orm import sessionmaker\nfrom shared.repository import Repository\ndata=json.load(sys.stdin)\nsettings=dotenv_values(".runtime/auth.env")\nengine=create_engine("postgresql+psycopg://",creator=lambda:psycopg.connect(settings["DATABASE_DSN"],connect_timeout=10),hide_parameters=True)\nrepo=Repository(sessionmaker(engine,expire_on_commit=False))\nuser=repo.user(user_id=data["id"])\nassert user and user.username==data["username"] and user.username.startswith("fido-smoke-")\nrepo.update_user(user.id,active=False,token_version=user.token_version+1)\nengine.dispose()\n'
    ], {input: JSON.stringify({id: fixtureId, username: fixture.username}), encoding: 'utf8'});
    console.log(JSON.stringify({fixture_disabled: cleanup.status === 0}));
    if (cleanup.status !== 0) process.exitCode = 1;
  }
  if (adminToken) await context.request.post(`${base}/api/auth/logout`, {headers: {Authorization: `Bearer ${adminToken}`}}).catch(() => {});
  await browser.close();
  console.log(JSON.stringify({completed_checks: checks, authenticator: 'virtual', physical_or_gpm_evidence: false}));
}
