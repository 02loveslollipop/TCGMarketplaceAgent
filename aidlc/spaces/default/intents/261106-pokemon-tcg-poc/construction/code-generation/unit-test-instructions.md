# Unit Test Instructions

## Scope

This is the sole zero-Unit Pokémon PoC implementation. Use test-after: implement each applicable layer, then write and run its tests before moving on. Bootstrap runners before the first executable test.

## Setup

1. From the workspace root run python3 -m venv .venv.
2. Run .venv/bin/python -m pip install -e '.[test]'.
3. In frontend/ run npm install.
4. Configure pytest in pyproject.toml and Vitest in frontend/vitest.config.ts.

## Exact test commands

From the workspace root, run each applicable layer after implementation:

- .venv/bin/python -m pytest tests/test_provisioning.py -q
- .venv/bin/python -m pytest tests/test_repository.py -q
- .venv/bin/python -m pytest tests/test_security.py -q
- .venv/bin/python -m pytest tests/test_suppliers.py -q
- .venv/bin/python -m pytest tests/test_budget.py -q
- .venv/bin/python -m pytest tests/test_agent.py -q
- .venv/bin/python -m pytest tests/test_api.py -q

For the assembled pre-FIDO2 implementation:

- .venv/bin/python -m pytest tests/test_provisioning.py tests/test_repository.py tests/test_security.py tests/test_suppliers.py tests/test_budget.py tests/test_agent.py tests/test_api.py -q

From frontend/:

- npx vitest run src/__tests__/chat.test.tsx src/__tests__/admin.test.tsx
- npx tsc --noEmit
- npm run build

After the requester's participation checkpoint and final FIDO2 implementation:

- .venv/bin/python -m pytest tests/test_webauthn.py -q
- Re-run the exact assembled checks with tests/test_webauthn.py appended, plus affected frontend checks.

For the requested first-login/recovery refinement, add tests/test_onboarding_recovery.py to that assembled Python command and run its scoped command .venv/bin/python -m pytest tests/test_onboarding_recovery.py -q after implementing each affected authentication layer. Run npx vitest run src/__tests__/chat.test.tsx src/__tests__/admin.test.tsx src/__tests__/onboarding.test.tsx from frontend/. Verify mandatory enrollment, limited-token authorization, code storage/one-time display, regeneration invalidation, recovery consumption/replay/races, and multiple authenticators. Use node scripts/onboarding_recovery_smoke.mjs for the actual browser/service fixture flow after rebuilding affected services. Keep real administrator recovery codes private and keep virtual-authenticator results separate from phone/physical-key evidence.

To verify a PostgreSQL race between two confirmations of the same TOTP enrollment using a disposable account, run `node scripts/onboarding_recovery_smoke.mjs --enrollment-race` after services start. The fixture is disabled during cleanup; the helper does not print secrets. This fixture check does not exercise a physical key.

Check Compose with docker compose config --quiet, build images, and inspect health without expanding/printing secrets.

For the requested login redesign, run the existing two frontend test files, TypeScript and the frontend build. Rebuild/recreate only web and admin-portal, then run node scripts/login_visual_check.mjs from the workspace root. This targeted real browser check reads the existing generated administrator credentials privately, verifies chat/admin login and responsive layout, and writes desktop/mobile screenshots under output/playwright/. It logs no passwords or tokens and performs no model or supplier calls.

## Coverage and meaningful cases

For local development mode, run the affected authentication and API tests and confirm the default requires 2FA, enabled mode still requires a valid password and active account, switching it off rejects bypass-issued sessions, and enrolled authenticators remain intact.

For the final-results revision, run `npx vitest run src/__tests__/chat.test.tsx` and `npm run build` from `frontend/`. Verify same-card variants are distinguishable in budget rows and missing quotations, including legacy results without variant details.

For the card-identity revision, run `.venv/bin/python -m pytest tests/test_budget.py tests/test_agent.py -q`. Verify distinct requested conditions for one card ID stay distinct, missing quantities and restrictions are retained, identical requests merge, and the agent interrupts for missing-card consent.

No numeric coverage threshold is defined. Map FR1–FR10/NFR1–NFR4 to assertions, and cover each component's happy path plus at least two relevant boundary/error scenarios. Tests must reject inadequate stock, variant mismatch, mixed-currency totals, unknown shipping treated as zero, unauthorized history/resume/admin access, missing consent, disabled models and pre-2FA token issuance. Include the full source-backed deck/quantity flow and rich streamed results.

## Fixtures and external services

Use fixture Actor payloads tied to the selected Actor schemas, a deterministic fake LangChain model/tool layer, synthetic cards/dated legality sources and an isolated test database/repository. Do not infer production readiness from mocked tests. Real database checks target only pokemon_tcg_poc and app-owned tables/roles. Never inspect unrelated schemas.

Actual provider, Actor and browser tests need usable credentials and a securely established initial account. Record unavailable integrations and unrun checks with reasons. Supplier retrieval remains logged-out, read-only public listing access; no technical block is bypassed and no automatic fallback product is invented.

## Physical-key checkpoint

Implement FIDO2 last, after the requester is asked and ready to test with both a key manager and a physical security key. Automated WebAuthn tests supplement those actual tests; record them separately.

