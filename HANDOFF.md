# Pokémon TCG agent PoC — continuation handoff

Prepared on **2026-11-08**, with final verification around **03:00 UTC / 12:00 JST**.
Workspace: `/home/zerotwo/supermarket_agent`.

The requester asked to finish the current checkpoint and leave this document for another agent with AI-DLC access (message `0d933985`). The work is intentionally handed over during **Code Generation**, without reporting stage completion or approval. The workflow is being parked at the end of this handoff session. Resume only when the requester asks to continue.

## 1. Read this first

- The current source passes **77 Python tests**, **11 existing frontend tests**, TypeScript/production build, and Compose configuration validation.
- Mandatory first-login 2FA and recovery-code code is written, but its **dedicated frontend test file is missing** and its **real browser/service integration has not run**.
- All six Compose services are currently **stopped**, each recorded as `Exited (0)`. They were not restarted during handoff preparation.
- The external application's schema contains the existing WebAuthn tables, but **does not yet contain `enrollment_states` or `recovery_codes`**. Provision those two app-owned tables/grants before serving the latest authentication code.
- The real initial administrator still has **one saved WebAuthn credential**. The requester confirmed Google Password Manager on their phone worked. Preserve that credential.
- Actual **physical FIDO2-key registration and sign-in are still pending**. Virtual-authenticator tests do not count as that evidence.
- `code-summary.md` and `traceability.json` are still missing. No final Code Generation review/gate or Build and Test stage has been completed.
- This directory is **not currently a Git repository** (`git status` reports no repository). No commit or branch was created. Do not claim changes were committed.

The previous developer subagent hit a usage limit after writing the new implementation and backend tests, before completing its promised frontend tests, database upgrade, image rebuild and browser verification. Its existence in an old agent tree does not mean it will resume automatically in a new session.

## 2. What the project is

A private, two-person **PoC**, not a public product. It demonstrates autonomous LangGraph/LangChain orchestration for Pokémon TCG requests: resolve cards/decks, ask about material ambiguity, research source-backed lists and legality, retrieve supplier offers, compare compatible stock/prices, handle substitutes and missing cards with consent, and explain a budget with links.

Confirmed architecture:

| Component | Implementation |
| --- | --- |
| Chat web app | React/TypeScript/Vite, Cloudscape, authenticated fetch SSE |
| Admin portal | Separate frontend entry/container, Cloudscape |
| Authentication | Python/FastAPI, app-managed OAuth2 password token flow, RSA JWTs, Argon2id, TOTP and WebAuthn |
| Admin API | FastAPI, server-side administrator authorization |
| Orchestrator | FastAPI, LangGraph/LangChain, durable SQL checkpoints and SSE |
| Gateway | Nginx, loopback port 8080, SSE buffering disabled |
| Local orchestration | Docker Compose, six runtime services |
| Database | Existing external PostgreSQL, dedicated `pokemon_tcg_poc` schema and restricted service roles |
| Models | Administratively enabled `gpt-6-luna`, `gpt-6.1-terra`, `mistral-medium-latest` |
| Supplier adapters | TCGplayer and Cardmarket via selected Apify Actors |

No geography-based selection, public registration, automatic purchasing, or public deployment is included. Lowest comparable price is the PoC selection rule. Currencies stay separate without sourced conversion; unknown shipping is not zero; stock is allocated once; reference market prices are not purchasable offers.

## 3. AI-DLC state and continuation

Active record:

`aidlc/spaces/default/intents/261106-pokemon-tcg-poc/`

Important files, relative to the workspace:

- [Workflow state](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/aidlc-state.md)
- [Requirements](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/inception/requirements-analysis/requirements.md)
- [Current 19-step code plan](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/construction/code-generation/code-generation-plan.md)
- [Planning answers and message references](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/construction/code-generation/planning-clarifications.md)
- [Test instructions](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/construction/code-generation/unit-test-instructions.md)
- [Detailed integration evidence and limitations](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/construction/code-generation/integration-evidence.md)
- [Implementation checkpoint](aidlc/spaces/default/intents/261106-pokemon-tcg-poc/construction/code-generation/implementation-checkpoint.md)

At handoff:

- Scope `poc`, depth/test strategy `Minimal`.
- Current stage `code-generation`; last completed `requirements-analysis`; next stage `build-and-test`.
- Steps 1–14 are ticked. Steps 15–19 remain unticked. Source/verification is ahead of some boxes; see the progress table below instead of assuming every unticked step lacks code.
- Zero-Unit work: no Unit DAG, synthetic Unit, worktree, Bolt or walking-skeleton ceremony is needed.
- Guard Policy and Plan Approval are off for this PoC. Sensors and learnings are on; collaborators are off. The last run-stage had Summary Confirmation off; use the next returned directive rather than overriding the apparent difference from the state file's scope default.
- The last directive used `mode: subagent`, lead `aidlc-developer-agent`, an advisory `aidlc-architecture-reviewer-agent` review, max one review iteration. Refresh this from the engine when resuming.
- Available at verification: `aidlc 2.11.3`, `codex-cli 0.163.0`.

When the requester resumes, invoke `$aidlc` normally and follow its recovery/routing instructions. The underlying next-step command is:

```sh
aidlc engine orchestrate next
```

Follow any exact command/receipt it returns. Do not hand-edit state, audits, question receipts or stage transitions. Do not report Code Generation complete merely to hand off. The latest first-login/recovery requirements are already answered; do not ask those choices again.

For a fresh developer dispatch, run the current tool-produced handoff and include it as the stage instructions require:

```sh
aidlc engine testing-posture brief --stage-level
```

The current plan's Testing Contract is **test-after**, with hash `sha256:be5041ec2297dded1a31f328fae6a86555cf649f231018ea8168c9bb8dd811a5`. Preserve its complete JSON unchanged. Use a fresh brief, not old cached text or copied agent handles. Stage review is after all final stage artifacts exist, not before.

## 4. Latest confirmed user choices

| Decision | Confirmation |
| --- | --- |
| FastAPI, React/TypeScript/Vite, SSE; separate microservices and local Compose | Earlier planning answers; architecture message `1ab54755` |
| App-managed OAuth2/JWT; no external Google/GitHub OAuth login | Planning Q2 |
| Agent can generate initial administrator credentials privately | `1487329c` |
| User added `APIFY_API_KEY` to `.env` for application use | `a78bfa54` |
| Login should follow `/home/zerotwo/coa-puroseka-heroku` | `5b2b0886`, active-work choice `7fcfd19b` |
| Proceed with final FIDO2 work; test password manager and physical key with Playwright | `2ee467bf` |
| Use Google Password Manager on the phone through Chrome's chooser | `7cb09033` |
| First phone request timed out; retry it | `1041e367` |
| Retry worked; check first-login setup, add recovery keys and multiple keys | `ae21a75f` |
| Require 2FA enrollment before chat/admin access | `3082879a` |
| Recovery means single-use backup codes, shown once and stored as hashes, replacing 2FA after the correct password | `b57e1dbc` |
| Prepare this handoff for another AI-DLC agent | `0d933985` |

The authentication refinements are separately recorded as **FR9a–FR9c** after the original requirements approval. Do not erase that distinction or invent an additional approval. No request to reset the real administrator's authenticators was given.

## 5. Authentication implementation now present

Main files:

| Area | Files |
| --- | --- |
| JWT/password/TOTP/onboarding/recovery logic | `services/auth/security.py` |
| WebAuthn verification and ceremonies | `services/auth/webauthn.py` |
| Auth routes | `services/auth/app.py`, `services/auth/main.py` |
| Models and repository/redaction | `shared/db.py`, `shared/repository.py` |
| Other-service session introspection | `shared/api.py` |
| Provisioning and minimum grants | `scripts/provision.py` |
| Login and authenticated shell | `frontend/src/Login.tsx`, `frontend/src/Shell.tsx` |
| New setup and recovery UI | `frontend/src/Onboarding.tsx`, `frontend/src/Recovery.tsx` |
| Existing authenticators UI | `frontend/src/WebAuthn.tsx`, `frontend/src/TotpSettings.tsx` |

### Mandatory setup

An active account without a confirmed TOTP secret or WebAuthn credential now receives `{requires_enrollment:true,enrollment_token}` after its correct password. It receives no normal access token. The enrollment token is purpose-bound, expires after five minutes, and is tied to a persisted enrollment challenge. `Security.current(..., kind='access')` also rejects old access tokens for accounts without a confirmed factor.

Other APIs use auth-service introspection, so chat/admin do not need privileges on credential tables. Initial setup can choose TOTP or a browser passkey/security key. Successful confirmation consumes setup, generates ten recovery codes, increments the token version, shows the codes and requires a fresh sign-in.

### Recovery

The implementation creates ten random 128-bit codes, formats them in groups, and stores only salted Argon2id hashes. Codes are displayed only in the creation/regeneration response. Status returns a remaining count. Recovery requires a validated password challenge, has an attempt limit, locks the user/challenge/code rows, consumes the matching code and challenge together, and preserves enrolled authenticators.

Regeneration requires a full authenticated session and the current password, replaces the old set, and revokes existing sessions. The UI has a download action and a saved-codes acknowledgement before returning to sign-in. No plaintext recovery codes should be persisted in browser storage, printed in tool output, included in chat, or captured in real-account screenshots.

### WebAuthn and multiple keys

Uses `webauthn`/py_webauthn on the server and `@simplewebauthn/browser` in React. Password-first 2FA remains the intended flow; this is not a new passwordless-login requirement. Multiple named credentials are supported, currently with a 20-credential cap. User presence/verification, fixed RP/origin, ownership, signatures, counters and single-use ceremonies are enforced. The last WebAuthn credential cannot be removed unless another WebAuthn credential or TOTP is available.

Default RP/origin: `localhost` / `http://localhost:8080`. Setup and ordinary registration are purpose-separated. Existing credentials are excluded during registration and reported transports are retained. Authentication defaults need no platform-only restriction, allowing both phone and physical keys.

## 6. Auth API contracts for browser continuation

All paths below have the gateway prefix `/api/auth`.

| Method/path | Input / result |
| --- | --- |
| `POST /token` | OAuth2 form username/password. Returns an enrollment token for no factor, or a second-factor challenge with available methods; no access before required 2FA. |
| `GET /session` | Full bearer session; account, role, TOTP status and WebAuthn enrollment/count. |
| `POST /onboarding/totp/enrollment` | Enrollment bearer; returns private setup secret/URI. |
| `POST /onboarding/totp/confirmation` | Enrollment bearer + `{code}`; returns enrolled/sign-in-again flags and one-time recovery codes. |
| `POST /onboarding/webauthn/registration/options` | Enrollment bearer + `{name}`; `{challenge_id,options}`. |
| `POST /onboarding/webauthn/registration/verify` | Enrollment bearer + `{challenge_id,credential}`; setup completion and one-time codes. |
| `POST /onboarding/webauthn/challenges/{id}/cancel` | Enrollment bearer; consumes the ceremony. |
| `POST /totp/challenge` | `{challenge_token,code}`; full token after verification. |
| `GET /webauthn/credentials` | Full bearer; only the account's credential metadata. |
| `POST /webauthn/registration/options` / `/verify` | Full bearer; ordinary additional-key registration. Enrollment revokes sessions and requires sign-in again. |
| `POST /webauthn/authentication/options` | `{challenge_token}`; `{challenge_id,options}`. |
| `POST /webauthn/authentication/verify` | `{challenge_token,challenge_id,credential}`; full token after verification. |
| `POST /webauthn/challenges/{id}/cancel` | Full bearer for registration, or password challenge in body for login. |
| `DELETE /webauthn/credentials/{id}` | Full bearer; own credential only, with last-factor protection. |
| `GET /recovery/status` | Full bearer; `{remaining}`. |
| `POST /recovery/regenerate` | Full bearer + `{password}`; one-time `recovery_codes`, sign-in again. |
| `POST /recovery/challenge` | `{challenge_token,code}`; a single-use 2FA alternative. |

Confirm source contracts before adapting a script; this table is a checkpoint, not an independent API specification.

## 7. Verification performed during this handoff

Fresh commands executed successfully on 2026-11-08:

```sh
.venv/bin/python -m pytest tests/test_provisioning.py tests/test_repository.py tests/test_security.py tests/test_suppliers.py tests/test_budget.py tests/test_agent.py tests/test_api.py tests/test_webauthn.py tests/test_onboarding_recovery.py -q
```

Result: **77 passed in 33.49s**. These tests use SQLite fixtures; they do not establish deployed PostgreSQL/browser behavior or concurrent PostgreSQL locking for the latest recovery flow. There are 21 original WebAuthn crypto/API tests and 14 new onboarding/recovery cases within this total.

From `frontend/`:

```sh
npx vitest run src/__tests__/chat.test.tsx src/__tests__/admin.test.tsx
npm run build
```

Results: **2 files / 11 tests passed**. Build runs `tsc --noEmit` and Vite, and passed. The existing large-bundle advisory remains; it was not silenced or treated as a failed build.

Also passed:

```sh
docker compose config --quiet
node --check scripts/onboarding_recovery_smoke.mjs
```

**Missing:** `frontend/src/__tests__/onboarding.test.tsx`. Neither existing frontend test file mentions onboarding/recovery. Do not describe the new UI as behavior-tested just because TypeScript/build and the older 11 tests pass.

A read-only database check used only the auth runtime DSN and exact app-schema objects. It confirmed:

| Object/check | Current result |
| --- | --- |
| `pokemon_tcg_poc.webauthn_credentials` | Exists |
| `pokemon_tcg_poc.webauthn_challenges` | Exists |
| `pokemon_tcg_poc.enrollment_states` | **Absent** |
| `pokemon_tcg_poc.recovery_codes` | **Absent** |
| Initial administrator's WebAuthn credential count | **1** |

No database writes, provisioning, live provider calls, Actor runs or browser authenticator prompts were performed during handoff preparation.

## 8. Earlier evidence, with its limits

These are historical results from before the mandatory-onboarding/recovery changes, detailed in `integration-evidence.md`:

- Six healthy local services and real browser administrator login/model policy administration.
- Actual GPT 6 luna/LangGraph clarification streamed over SSE, persisted in the app schema, restored after a fresh login, and cancelled. The test restored the previous model enabled state and revoked sessions.
- Both requested OpenAI IDs were listed and succeeded through the actual LangChain model factory. Mistral discovery succeeded but inference returned HTTP 429 on 2026-11-06; no silent fallback was used. This is not a new quota check.
- Free DDGS research and keyless TCGdex card metadata worked. Ambiguous M Gardevoir EX returned clarification. A proposed Mega Lucario/Toucannon Standard combination led to a source-backed follow-up rather than an invented used list. A completed live 60-card deck remains unverified.
- Apify credentials authenticated, but no selected supplier Actor was run. No verified live supplier quotation exists.
- The reference-inspired login passed 7 then-existing frontend tests and 12 real-browser checks, including keyboard login, errors, logout, desktop/mobile layout and overflow. Both portal screenshots were inspected.
- A separate virtual-authenticator Chrome/PostgreSQL preflight passed eight browser assertions: registration/session revocation, no access from a password challenge, cancellation/server consumption/retry, an actual assertion, concurrent assertion replay yielding exactly one HTTP 200 and one HTTP 401, last-key deletion rejection, and logout.
- That preflight's cleanup originally expected `DATABASE_URL`; runtime uses `DATABASE_DSN`. The helper was corrected and the one fixture account was narrowly identified, disabled and its sessions revoked. The whole helper was not rerun after that cleanup repair.
- Real phone enrollment timed out once, then was retried and confirmed by the requester. The authenticated UI showed exactly one named credential, `Google Password Manager (phone)`, enrolled at 2026-11-07 07:56:43 JST. The separate real-phone assertion transaction was not captured by the helper. Do not label virtual signatures as real phone/physical-key evidence.

Existing screenshots under `output/playwright/` include the four `*login-redesign*` previews, `admin.png` and `chat-clarification.png`. The new helper's `first-login-onboarding.png`, `recovery-codes-masked.png` and `multiple-authenticators.png` do **not** exist yet.

## 9. Browser helpers and important compatibility notes

### New helper: `scripts/onboarding_recovery_smoke.mjs`

Written and syntax-checked, **not executed**. Intended to run after provisioning and rebuilding:

```sh
node scripts/onboarding_recovery_smoke.mjs
```

It creates disposable ordinary-user fixtures through the app's auth runtime role; no administrator 2FA bypass is needed. It uses a separate headless Chrome with virtual authenticators, keeps secrets in memory, and disables only its own generated fixture accounts afterward. Its ignored `.runtime/onboarding-fixtures.json` manifest contains only fixture IDs/usernames/disabled flags and allows exact cleanup recovery:

```sh
node scripts/onboarding_recovery_smoke.mjs --cleanup
```

The manifest is currently absent because the helper has not run. The script plans to exercise limited setup-token rejection by normal APIs, TOTP setup, one-time display/download/save, fresh 2FA login, recovery replay, same-code races across separate password challenges, regeneration/session revocation, WebAuthn onboarding, a second authenticator, and continued use of the first key.

Validate and fix real integration failures rather than weakening assertions. Pay attention to selectors, download timing, single-use TOTP time steps, the 10-password-attempts-per-minute limit, and reusing a virtual credential with the correct signature counter. Its screenshots mask the recovery-code container and are fixture-only.

### Older helpers

- `scripts/fido_browser.mjs`: private generated-password UI login/status for the dedicated headed Chrome on CDP port 9227. Supports `status` and `login`. With an enrolled administrator, password login now leaves the real second-factor prompt to the requester.
- `scripts/fido_virtual_smoke.mjs`: historical eight-check preflight. Its fixture setup assumes the real admin can obtain an access token using only the password, and its fixture initial login assumes no mandatory setup. **Do not run it unchanged under the new policy.** Adapt it or supersede it with the new helper.
- `scripts/login_visual_check.mjs` and `scripts/browser_smoke.mjs`: also contain earlier direct-admin-login assumptions. Adapt their fixtures/authentication when rerunning; never disable 2FA or remove the real user's credential to make them pass.

### Actual user devices

The old headed CDP endpoint `http://127.0.0.1:9227` is **not listening** at handoff. The old browser/session must not be assumed alive. To recreate it on this machine, use a dedicated ignored profile and the local display, not the person's regular browser profile:

```sh
/usr/bin/google-chrome --user-data-dir=/home/zerotwo/supermarket_agent/.runtime/fido-chrome --remote-debugging-port=9227 --remote-debugging-address=127.0.0.1 --no-first-run http://localhost:8080/
```

Attach the Playwright CLI using the existing ignored CDP config:

```sh
/home/zerotwo/.codex/skills/playwright/scripts/playwright_cli.sh -s=pokemon-fido open http://localhost:8080/ --config .runtime/playwright-fido.json
```

Old mouse clicks on the off-screen expandable section timed out while keyboard activation worked. Take a fresh snapshot and use the current references/accessible controls; `bringToFront()` plus keyboard `press('Enter')` on the known button was reliable. Do not assume old snapshot IDs survive.

Keep virtual authenticators entirely out of the real device window. For Google Password Manager the requester chose their phone, using Chrome's QR chooser, so do not demand Google sign-in in the test desktop profile. Let the requester handle phone unlock, PINs, biometrics and physical key touches privately. Native prompts expire; open them when the requester is watching. Never snapshot the real recovery-code screen or print its response body.

## 10. Remaining work in priority order

1. Resume through AI-DLC, read the current plan/answers, and dispatch the developer with a fresh Testing Contract brief. Review the code written before the previous agent's usage limit.
2. Add the missing `frontend/src/__tests__/onboarding.test.tsx` and test the new onboarding/recovery UX: no access before confirmation, both setup methods, cancellation/expiry, save/download/clear-on-finish, password-confirmed regeneration and recovery sign-in. Keep the existing 77 Python/11 frontend tests green. Verify any missing server race/API cases rather than inferring them from sequential SQLite tests.
3. Run the idempotent app-only provisioner to add the two missing tables/grants. Preserve existing runtime credentials and the saved phone credential. Do not re-bootstrap or reset the administrator.
4. Rebuild/start affected services and verify all six are healthy. Merely starting old images will not serve the new source. Check app-role permissions and only the app-owned schema.
5. Run/fix the new real browser/service helper. Inspect the generated non-secret/masked screenshots. Verify no setup token can access chat/admin and only one concurrent recovery-code use succeeds. Clean up only generated fixture users.
6. With the requester, verify fresh phone sign-in and register a second, physical FIDO2 key on the same real account; test sign-in with each. Preserve the original phone credential. Existing accounts with a factor can generate recovery codes in settings; require the real password privately, let the requester save the one-time display, and capture no plaintext.
7. Update deployment instructions and stale historical checkpoint wording. In particular, `deploy/README.md` still says FIDO2 is unimplemented and does not explain mandatory setup/recovery.
8. Complete `code-summary.md`, `traceability.json` and the final test instructions under the current stage record. Reconcile plan checkboxes from actual results. Only then run the declared independent review and completion checks/sensors, follow the actual approval gate, and let AI-DLC route to Build and Test. That stage has not run yet.

Suggested provisioning/start commands once code/test gaps are addressed:

```sh
.venv/bin/python -m scripts.provision
.venv/bin/python -m scripts.check_database
docker compose config --quiet
docker compose up --build -d --wait
docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
```

The existing bootstrap is already complete: omit `scripts.bootstrap_admin` here.

## 11. Security and scope boundaries to preserve

- Root `.env` and `.runtime/` are private. The administrator password is only in ignored `.runtime/bootstrap-admin.json`, mode 0600; runtime env files are also mode 0600. Read privately in process when needed, never in chat, CLI arguments, logs or screenshots. Do not add default credentials.
- `.env` contains provider keys and `EXTERNAL_JDBC_POSTGRES_URI_ADMIN`; only provisioning uses the admin URI. Runtime uses per-service `DATABASE_DSN` files, not a `DATABASE_URL`. Never use the database admin account for the app.
- Do not read/use any other project's schemas or broaden database-wide grants. Roles are `pokemon_poc_auth`, `pokemon_poc_admin`, `pokemon_poc_orchestrator`; only the new application schema/tables are in scope.
- Preserve the user's `.env`, original `AGENTS.md` and existing work. Do not copy secrets into this document or normal source. Do not read the person's regular Chrome password/profile storage.
- Initial administrator creation was expressly authorized earlier; no permission to reset its enrolled phone credential was given.
- Only the orchestrator receives OpenAI/Mistral/Apify keys. `APIFY_API_KEY` is primary, `APIFY_TOKEN` an accepted alias.
- Supplier retrieval is logged-out, read-only access to public listings through Apify. Do not bypass a login, paywall, CAPTCHA or other technical block, and collect only public listing data with no personal data beyond public seller display names.
- Use `crawloop/tcgplayer-listings-scraper` with proxies disabled and `phantom_coder/cardmarket-listings-scraper` with paid fair-value enrichment disabled. The earlier devcake Actor was never run and is not the implementation choice.
- No completed live 60-card purchasing result or supplier coverage has been established. Keep fixture results, research results, provider inference, real offers and actual device tests distinct.

## 12. Documentation and knowledge for the next agent

Read root `AGENTS.md`, the active AI-DLC instructions and record artifacts before changing architecture or scope. The source requirements and prior intent/supplier research remain authoritative alongside the explicitly recorded FR9a–FR9c refinements. The login reference was inspected read-only at `/home/zerotwo/coa-puroseka-heroku/web/src/App.tsx`, `styles.css` and `main.tsx`; do not import its account data or authentication contracts.

Implementation references already consulted include [Cloudscape](https://cloudscape.design/llms.txt), [py_webauthn](https://duo-labs.github.io/py_webauthn/), [Google's passkey environments](https://developers.google.com/identity/passkeys/supported-environments), [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html), and [NIST authentication/recovery guidance](https://pages.nist.gov/800-63-4/sp800-63b.html). Their use does not establish formal standards compliance.

This handoff describes a **verified source checkpoint with unfinished integration and human-device testing**, not a finished PoC or a production security assessment.
