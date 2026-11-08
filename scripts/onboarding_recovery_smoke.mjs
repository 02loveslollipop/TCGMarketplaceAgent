// Real local browser/service verification with disposable users only.
// Recovery codes, TOTP seeds, passwords, JWTs and virtual private keys stay in
// memory. This is not evidence of a person's phone or physical security key.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';

const base = 'http://localhost:8080';
const manifestPath = new URL('../.runtime/onboarding-fixtures.json', import.meta.url);
const records = [];
const pythonSetup = `import json,sys,psycopg
from dotenv import dotenv_values
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from shared.repository import Repository
from services.auth.security import hash_password
data=json.load(sys.stdin)
settings=dotenv_values('.runtime/auth.env')
engine=create_engine('postgresql+psycopg://',creator=lambda:psycopg.connect(settings['DATABASE_DSN'],connect_timeout=10),hide_parameters=True)
repo=Repository(sessionmaker(engine,expire_on_commit=False))
assert data['username'].startswith('onboarding-smoke-')
if data['action']=='create':
    user=repo.add_user(data['username'],hash_password(data['password']),'user')
    print(json.dumps({'id':user.id}))
else:
    user=repo.user(user_id=data['id'])
    assert user and user.username==data['username'] and user.role=='user'
    repo.update_user(user.id,active=False,token_version=user.token_version+1)
engine.dispose()
`;
function privatePython(code, data) {
  const result = spawnSync('.venv/bin/python', ['-c', code], {input: JSON.stringify(data), encoding: 'utf8'});
  if (result.status !== 0) throw new Error('Private fixture operation failed');
  return result.stdout.trim();
}
async function saveManifest() {
  await writeFile(manifestPath, JSON.stringify(records.map(({id, username, disabled}) => ({id, username, disabled}))), {mode: 0o600});
}
async function fixture() {
  const account = {username: `onboarding-smoke-${randomUUID().slice(0, 12)}`, password: randomBytes(32).toString('base64url')};
  const {id} = JSON.parse(privatePython(pythonSetup, {...account, action: 'create'}));
  records.push({id, username: account.username, disabled: false});
  await saveManifest();
  return account;
}
async function cleanup() {
  let successful = true;
  for (const account of records.filter(row => !row.disabled)) {
    try {
      privatePython(pythonSetup, {...account, action: 'disable'});
      account.disabled = true;
      await saveManifest();
    } catch { successful = false; }
  }
  console.log(JSON.stringify({fixture_cleanup: successful}));
  return successful;
}
if (process.argv.includes('--cleanup')) {
  records.push(...JSON.parse(await readFile(manifestPath, 'utf8')));
  process.exit(await cleanup() ? 0 : 1);
}
try {
  records.push(...JSON.parse(await readFile(manifestPath, 'utf8')));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (records.some(row => !row.disabled) && !await cleanup()) process.exit(1);

const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
const page = await context.newPage();
let phase = 'setup';
let checks = 0;
const passed = check => { checks++; console.log(JSON.stringify({check, passed: true, authenticator: 'virtual/test-fixture'})); };
const jsonResponse = path => page.waitForResponse(r => r.url() === `${base}/api/auth/${path}` && r.request().method() === 'POST');
const headers = token => ({Authorization: `Bearer ${token}`});
const totp = (secret, offset = 0) => privatePython('import json,sys,time,pyotp\ndata=json.load(sys.stdin)\nprint(pyotp.TOTP(data["secret"]).at(time.time()+30*data["offset"]))', {secret, offset});
const virtualOptions = {protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true};
async function login(account) {
  await page.getByRole('textbox', {name: 'Username', exact: true}).fill(account.username);
  await page.getByLabel('Password', {exact: true}).fill(account.password);
  const pending = jsonResponse('token');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  return response.json();
}
async function rejectNormalApis(token) {
  for (const path of ['/api/auth/session', '/api/admin/models', '/api/chat/conversations']) {
    const response = await context.request.get(`${base}${path}`, {headers: headers(token)});
    assert.equal(response.status(), 401);
  }
}
async function expectAuthenticated() {
  await page.getByRole('heading', {name: 'Pokémon deck agent', exact: true}).waitFor();
}
async function signOut() {
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await page.getByRole('heading', {name: 'Sign in', exact: true}).waitFor();
}
async function useWebAuthn() {
  const pending = jsonResponse('webauthn/authentication/verify');
  await page.getByRole('button', {name: 'Use passkey or security key', exact: true}).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert(result.access_token);
  await expectAuthenticated();
  return result.access_token;
}
async function recover(account, code) {
  const challenge = await login(account);
  assert(challenge.challenge_token && !challenge.access_token);
  await page.getByRole('button', {name: 'Use a recovery code', exact: true}).click();
  const response = await submitRecovery(code);
  return {response, challenge};
}
async function submitRecovery(code) {
  await page.getByRole('textbox', {name: 'Recovery code', exact: true}).fill(code);
  const pending = jsonResponse('recovery/challenge');
  await page.getByRole('button', {name: 'Use recovery code', exact: true}).click();
  return pending;
}
async function finishCodes(codes, {download = false, screenshot = false} = {}) {
  assert(codes.length >= 2 && new Set(codes).size === codes.length);
  await page.getByRole('heading', {name: 'Save your recovery codes', exact: true}).waitFor();
  assert(await page.getByTestId('recovery-finish-button').isDisabled());
  const displayed = await page.getByTestId('recovery-codes-secret').innerText();
  assert(codes.every(code => displayed.includes(code)));
  if (download) {
    const pending = page.waitForEvent('download');
    await page.getByTestId('download-recovery-codes').click();
    const file = await pending;
    assert.equal(file.suggestedFilename(), 'pokemon-tcg-recovery-codes.txt');
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    assert(codes.every(code => text.includes(code)));
  }
  if (screenshot) await page.screenshot({path: 'output/playwright/recovery-codes-masked.png', fullPage: true, mask: [page.getByTestId('recovery-codes-secret')]});
  await page.getByRole('checkbox', {name: 'I have saved these recovery codes', exact: true}).check();
  await page.getByTestId('recovery-finish-button').click();
  await page.getByRole('heading', {name: 'Sign in', exact: true}).waitFor();
  assert(!(await page.locator('body').innerText()).includes(codes[0]));
}

try {
  if (process.argv.includes('--enrollment-race')) {
    phase = 'enrollment_confirmation_race';
    const account = await fixture();
    const tokenResponse = await context.request.post(`${base}/api/auth/token`, {form: account});
    assert.equal(tokenResponse.status(), 200);
    const setup = await tokenResponse.json();
    assert(setup.enrollment_token && !setup.access_token);
    const secretResponse = await context.request.post(`${base}/api/auth/onboarding/totp/enrollment`, {headers: headers(setup.enrollment_token)});
    assert.equal(secretResponse.status(), 200);
    const {secret} = await secretResponse.json();
    const code = totp(secret);
    const results = await Promise.all([1, 2].map(() => context.request.post(`${base}/api/auth/onboarding/totp/confirmation`, {headers: headers(setup.enrollment_token), data: {code}})));
    assert.deepEqual(results.map(result => result.status()).sort(), [200, 401]);
    const success = results.find(result => result.status() === 200);
    assert.equal((await success.json()).recovery_codes.length, 10);
    passed('Concurrent confirmation of a single enrollment succeeds once');
  } else {
  phase = 'mandatory_setup';
  const totpUser = await fixture();
  await page.goto(`${base}/`);
  const setup = await login(totpUser);
  assert.equal(setup.requires_enrollment, true);
  assert(setup.enrollment_token && !setup.access_token);
  await page.getByRole('heading', {name: 'Set up two-factor authentication', exact: true}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Pokémon deck agent', exact: true}).isVisible(), false);
  await rejectNormalApis(setup.enrollment_token);
  const premature = await context.request.post(`${base}/api/auth/recovery/regenerate`, {headers: headers(setup.enrollment_token), data: {password: totpUser.password}});
  assert.equal(premature.status(), 401);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path: 'output/playwright/first-login-onboarding.png', fullPage: true});
  passed('First login is restricted to setup; enrollment tokens cannot access chat, admin, sessions or recovery generation');

  phase = 'totp_enrollment';
  await page.getByTestId('onboarding-choose-totp').click();
  const secretField = page.getByRole('textbox', {name: 'Setup key', exact: true});
  await secretField.waitFor();
  const seed = await secretField.inputValue();
  assert(seed);
  await page.getByRole('textbox', {name: 'Authenticator code', exact: true}).fill(totp(seed));
  const confirmation = jsonResponse('onboarding/totp/confirmation');
  await page.getByTestId('onboarding-confirm-totp').click();
  const confirmed = await confirmation;
  assert.equal(confirmed.status(), 200);
  const originalCodes = (await confirmed.json()).recovery_codes;
  await finishCodes(originalCodes, {download: true, screenshot: true});
  const oldSetup = await context.request.post(`${base}/api/auth/onboarding/totp/enrollment`, {headers: headers(setup.enrollment_token)});
  assert.equal(oldSetup.status(), 401);
  passed('Confirmed authenticator setup shows codes once, supports private download and consumes the setup session');

  phase = 'fresh_totp_login';
  const challenge = await login(totpUser);
  assert(challenge.challenge_token && !challenge.access_token && !challenge.enrollment_token);
  await page.getByRole('textbox', {name: 'Authenticator code', exact: true}).fill(totp(seed, 1));
  const totpProof = jsonResponse('totp/challenge');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  assert.equal((await totpProof).status(), 200);
  await expectAuthenticated();
  await signOut();
  passed('A fresh post-enrollment sign-in requires and accepts the authenticator second factor');

  phase = 'recovery_login';
  let recovered = await recover(totpUser, originalCodes[0]);
  assert.equal(recovered.response.status(), 200);
  let access = (await recovered.response.json()).access_token;
  assert(access);
  await expectAuthenticated();
  const remaining = await context.request.get(`${base}/api/auth/recovery/status`, {headers: headers(access)});
  assert.equal((await remaining.json()).remaining, originalCodes.length - 1);
  await signOut();
  passed('An unused recovery code completes password-first login and decrements the remaining count');

  phase = 'recovery_replay';
  recovered = await recover(totpUser, originalCodes[0]);
  assert.equal(recovered.response.status(), 401);
  assert.equal(await page.getByRole('heading', {name: 'Pokémon deck agent', exact: true}).isVisible(), false);
  const retry = await submitRecovery(originalCodes[1]);
  assert.equal(retry.status(), 200);
  access = (await retry.json()).access_token;
  await expectAuthenticated();
  passed('A used recovery code is rejected and a fresh code can complete the still-limited login');

  phase = 'recovery_race';
  const parentResponses = await Promise.all([1, 2].map(() => context.request.post(`${base}/api/auth/token`, {form: totpUser})));
  assert(parentResponses.every(response => response.status() === 200));
  const parents = await Promise.all(parentResponses.map(response => response.json()));
  assert(parents.every(parent => parent.challenge_token && !parent.access_token));
  const race = await Promise.all(parents.map(parent => context.request.post(`${base}/api/auth/recovery/challenge`, {data: {challenge_token: parent.challenge_token, code: originalCodes[2]}})));
  assert.deepEqual(race.map(response => response.status()).sort(), [200, 401]);
  passed('One recovery code raced across two distinct password challenges succeeds exactly once');

  phase = 'regeneration';
  await page.getByRole('button', {name: 'Recovery codes', exact: true}).click();
  await page.getByRole('textbox', {name: 'Current password', exact: true}).fill(totpUser.password);
  const replacement = jsonResponse('recovery/regenerate');
  await page.getByTestId('recovery-regenerate-button').click();
  const regenerated = await replacement;
  assert.equal(regenerated.status(), 200);
  const newCodes = (await regenerated.json()).recovery_codes;
  assert(newCodes.every(code => !originalCodes.includes(code)));
  await finishCodes(newCodes);
  const invalidated = await context.request.get(`${base}/api/auth/session`, {headers: headers(access)});
  assert.equal(invalidated.status(), 401);
  recovered = await recover(totpUser, originalCodes.at(-1));
  assert.equal(recovered.response.status(), 401);
  const replaced = await submitRecovery(newCodes[0]);
  assert.equal(replaced.status(), 200);
  await expectAuthenticated();
  await signOut();
  passed('Password-confirmed regeneration replaces old codes, revokes prior sessions and permits the new set');

  phase = 'webauthn_onboarding';
  const keyUser = await fixture();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: virtualOptions});
  const keySetup = await login(keyUser);
  assert(keySetup.enrollment_token && !keySetup.access_token);
  await page.getByTestId('onboarding-choose-webauthn').click();
  await page.getByRole('textbox', {name: 'Authenticator name', exact: true}).fill('First preflight key');
  const registered = jsonResponse('onboarding/webauthn/registration/verify');
  await page.getByTestId('onboarding-register-key').click();
  const registration = await registered;
  assert.equal(registration.status(), 200);
  await finishCodes((await registration.json()).recovery_codes);
  await login(keyUser);
  await useWebAuthn();
  const firstKey = (await cdp.send('WebAuthn.getCredentials', {authenticatorId})).credentials[0];
  assert(firstKey);
  passed('A new account can enroll a browser credential and then authenticate with it');

  phase = 'second_authenticator';
  await cdp.send('WebAuthn.removeVirtualAuthenticator', {authenticatorId});
  ({authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: virtualOptions}));
  await page.getByRole('button', {name: 'Passkeys and security keys', exact: true}).click();
  await page.getByRole('textbox', {name: 'Authenticator name', exact: true}).fill('Second preflight key');
  const secondRegistration = jsonResponse('webauthn/registration/verify');
  await page.getByRole('button', {name: 'Add passkey or security key', exact: true}).click();
  assert.equal((await secondRegistration).status(), 200);
  await page.getByRole('heading', {name: 'Sign in', exact: true}).waitFor();
  await login(keyUser);
  access = await useWebAuthn();
  const credentials = await context.request.get(`${base}/api/auth/webauthn/credentials`, {headers: headers(access)});
  const names = (await credentials.json()).map(row => row.name).sort();
  assert.deepEqual(names, ['First preflight key', 'Second preflight key']);
  await page.getByRole('button', {name: 'Passkeys and security keys', exact: true}).click();
  await page.screenshot({path: 'output/playwright/multiple-authenticators.png', fullPage: true});
  await signOut();
  passed('A second named authenticator is added and works while the first remains enrolled');

  phase = 'original_authenticator_preserved';
  await cdp.send('WebAuthn.removeVirtualAuthenticator', {authenticatorId});
  ({authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: virtualOptions}));
  await cdp.send('WebAuthn.addCredential', {authenticatorId, credential: firstKey});
  await login(keyUser);
  await useWebAuthn();
  await signOut();
  passed('The originally enrolled credential still authenticates after a second key is added');
  }
} catch (error) {
  // Playwright messages can contain input values; never print them or a stack.
  console.log(JSON.stringify({passed: false, phase, error_type: error.name}));
  process.exitCode = 1;
} finally {
  if (!await cleanup()) process.exitCode = 1;
  await browser.close();
  console.log(JSON.stringify({completed_checks: checks, actual_device_evidence: false}));
}
