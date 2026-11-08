# Build and Test Results

## Current execution

Latest rerun after the allocation, variant display, and local-development changes: `.venv/bin/python -m pytest tests -q` passed 86 tests, 0 failed, 0 skipped; `npx vitest run` passed 20 tests; `npm run build` passed TypeScript and Vite with the existing bundle-size advisory. All six Compose services reported healthy. The live app currently uses the explicitly enabled local password-only mode. Its correct-password access, invalid-password rejection, chat/admin introspection, and two retained authenticators were checked before this rerun; see `../code-generation/code-summary.md` and `deploy/README.md` for operation. The results below are earlier executions, not additional unique tests.

- Assembled Python suite: 77 passed, 0 failed, 0 skipped; `.venv/bin/python -m pytest tests/test_provisioning.py tests/test_repository.py tests/test_security.py tests/test_suppliers.py tests/test_budget.py tests/test_agent.py tests/test_api.py tests/test_webauthn.py tests/test_onboarding_recovery.py -q`.
- Individual planned Python files: provisioning 2, repository 3, security 4, suppliers 16, budget 4, agent 7, API 6, WebAuthn 21, onboarding/recovery 14 passed; no failures. These are reruns of the same tests, not additional unique tests. The pre-WebAuthn assembled selection passed 42.
- Frontend: `npx vitest run src/__tests__/chat.test.tsx src/__tests__/admin.test.tsx src/__tests__/onboarding.test.tsx` passed 17; the older two-file selection passed 11. These run in a DOM emulator. `npx tsc --noEmit` and `npm run build` passed; Vite reported its existing large-bundle advisory.
- `docker compose config --quiet` passed; all six running services reported healthy. Images were rebuilt before this stage; see `../code-generation/integration-evidence.md`.
- Coverage percentage was not collected; no numerical coverage floor was defined.

## Integration evidence and limits

On 2026-11-08 a further real in-app Chromium test used a disposable account in explicitly enabled local password-only mode. Login and admin model-policy verification succeeded. GPT 6 luna was temporarily enabled, then a real Mega Lucario request streamed progress and asked for format and card preferences. After clarification, the agent streamed web research and requested a source link because it could not verify the requested historical list. The test was cancelled; it did not reach an actual deck or budget. The model was restored to disabled and unverified, its previous state; the disposable account was disabled, demoted, and its sessions revoked. No supplier Actor was run. Latest full rerun: 86 Python tests and 20 frontend tests passed; production build passed with the existing bundle advisory.

After the Build and Test gate opened, the final-results React component was also rendered in the real in-app Chromium browser using a temporary, explicitly synthetic Vite fixture. Browser inspection showed separate NM and LP rows for the same card, a purchase link on the NM row, the LP variant in the missing-quotation alert, and unknown shipping and final total displayed as such. The fixture did not exercise authentication, streaming, live suppliers or the full deployed application flow; its temporary files were removed and its Vite server stopped.

Earlier in the same work, Chromium with disposable accounts against rebuilt services and PostgreSQL passed ten onboarding/recovery and virtual-key checks, and a separate concurrent enrollment confirmation check passed. The phone and physical-key sign-ins were user-assisted and their resulting authenticated sessions observed; the private device assertions were not independently captured. These browser and database tests were not repeated in this stage; the older login helper assumes password-only administrator access and was not rerun after mandatory 2FA. No live supplier Actor or complete sourced live purchase was verified. Mistral inference previously returned HTTP 429.

The earlier independent review found that cheapest-first allocation could miss a feasible complete allocation when flexible and restrictive requests share stock. The algorithm and variant-aware missing-card consent were subsequently fixed, regression-tested, and independently reviewed. A temporary administrator password appeared in tool output and the user plans to replace the account later. Recovery codes are stored privately under `.runtime/` with mode 0600.

## Loop-Back Log

### Loop-back 1 — 2026-11-08T04:00:15Z

- Diagnosis: the existing suite does not test an allocation where flexible and restricted requests share limited stock; the reviewer demonstrated an incorrect incomplete result.
- Root-cause stage: code-generation, allocation algorithm and tests.
- Planned fix: use an allocation approach that maximizes coverage before minimizing comparable subtotal, and add a regression for overlapping flexible/restricted requests.
- Estimated impact: moderate development and review effort; no anticipated external service charges; moderate risk of changing stock and price selection, mitigated by regression and existing tests. No fix has been applied.
