# Code Generation Plan

## Summary

- Builds: Private Pokémon TCG agent PoC with Cloudscape chat and admin portals, FastAPI microservices, PostgreSQL isolation, and Docker Compose.
- Touches: services/, shared/, frontend/, deploy/, scripts/, tests/, compose.yaml, pyproject.toml, .env.example, and narrowly scoped .gitignore additions.
- Tests: Requirement-driven Python unit/API tests, React component tests, Compose smoke checks, and a final interactive FIDO2 verification.

## Inputs and confirmed choices

- Approved requirements: ../../inception/requirements-analysis/requirements.md (FR1–FR10 and NFR1–NFR4).
- Clarifications: planning-clarifications.md. The requester selected Python FastAPI, React TypeScript/Vite, SSE, app-managed OAuth2/JWT, independently runnable microservices and Docker Compose for local development.
- Intent: ../../ideation/intent-capture/intent-statement.md.
- Supplier investigation: ../../ideation/intent-capture/supplier-research.md. TCGplayer and Cardmarket Actors are selected for logged-out, read-only public listing retrieval. Implement the adapters without inventing prices.
- No user stories or separate design artifacts were produced by this PoC workflow; trace steps directly to requirements.
- First-administrator setup uses a local interactive bootstrap command; never invent a username/password, put credentials in chat, or ship a default password.
- No public deployment is included.
- Login revision requested in message 5b2b0886 and confirmed as part of this work in 7fcfd19b: adapt the full-height split-screen login from /home/zerotwo/coa-puroseka-heroku/web/src/App.tsx and its styles.css, using this application's Pokémon TCG branding and Cloudscape controls. FIDO2 stays pending until that revision is delivered and the requester is ready for interactive testing.

## Service boundaries and runtime

- gateway: reverse proxy serving the chat web app and a separate admin portal, routing /api/auth, /api/admin and /api/chat, with SSE buffering disabled.
- auth: FastAPI OAuth2 token endpoints, JWT signing and verification, Argon2id passwords, authenticated session management and TOTP; FIDO2 is the final implementation step.
- admin-api: FastAPI administrative authorization, account creation through auth and allowed-model administration. Enforce admin roles at API boundaries.
- orchestrator: FastAPI chat/execution/history APIs and SSE. Execute LangGraph with LangChain model/tool integrations and resumable clarification/substitution decisions.
- web: React/TypeScript/Vite chat interface built entirely around Cloudscape components.
- admin-portal: independently runnable React/TypeScript/Vite Cloudscape entry point for accounts and allowed models; shared frontend code is permitted.
- provision: one-shot Compose profile/CLI that alone receives the root .env database admin URI; provisions only a new pokemon_tcg_poc schema and app-owned roles/tables. Do not inspect other project schemas, enumerate their objects, alter database-wide defaults or revoke shared PUBLIC grants.
- PostgreSQL remains the existing external database. Use service-specific credentials/grants within the new schema; no runtime service receives the admin URI. Generated service secret files stay under ignored .runtime/ with restrictive permissions. Minimize secrets given to each service; only orchestrator gets provider/Apify keys.
- Local development is bound to loopback. Document localhost WebAuthn secure-context behavior; support TLS termination for use beyond localhost without claiming deployment.

## Implementation steps

- [x] Revision — Add an explicit local development configuration switch, off by default, allowing password-authenticated active accounts to sign in without 2FA while enabled. Preserve enrolled authenticators, enforce normal 2FA when off, prevent dev-mode access tokens from remaining valid when disabled, document the configuration, and add authentication and session tests. [User requests f60d097e, 8b6ee29a]

- [ ] Revision — Display card set, number, condition, language and printing in final budget rows and missing-quotation results so same-name variants are distinguishable. Cover same-card variants in frontend tests. [FR5–FR7; user request efeb074c]

- [ ] Revision — Track missing coverage by normalized card request identity, including set, number, condition, language and printing, preserving the missing variant's restrictions and quantity. Verify distinct variants sharing a card ID, identical-request merging, and the agent's missing-card consent interruption. [FR4–FR6; user request cbb0d33c]

- [ ] Step 1 — Create Python/package and frontend workspace skeletons, test runner configuration, .env.example, and narrowly scoped ignores for .venv, node_modules, build artifacts and .runtime; preserve the existing .env and AGENTS.md. Add explicit dependencies for FastAPI/Uvicorn, SQLAlchemy/psycopg, LangGraph/LangChain OpenAI/Mistral, httpx, JWT, Argon2id, TOTP/encryption, ddgs, pytest, React/Vite/TypeScript, Cloudscape, Vitest and Testing Library. Use normal package-manager install/lock commands and Docker builds; keep any generated files inside the workspace. [FR7–FR10, NFR1]
- [ ] Step 2 — Implement typed data contracts, application schema and idempotent provisioning scripts; separate user/security, model-policy and conversation/execution tables. Provision using .env without printing it; create runtime accounts with only required table/sequence/schema privileges, no schema creation, role creation or ownership. Handle existing app schema safely. Add and run tests/test_provisioning.py after implementation, using inspected SQL statements to ensure no other project schemas are accessed. [FR3, FR6, FR10, NFR1–NFR3]
- [ ] Step 3 — Implement repository operations for accounts, enabled models, conversations, messages, persisted execution steps/checkpoints and redacted logs. Enforce per-user history/execution access. Add and run tests/test_repository.py after implementation; live integration checks are limited to the dedicated schema. [FR8–FR10, NFR1, NFR3]
- [ ] Step 4 — Implement authentication domain logic: Argon2id, expiring JWTs with issuer/audience/type checks, server-enforced account state and administrative roles, TOTP enrollment/confirmation/challenge and encrypted TOTP secret storage. Avoid granting full access tokens before required second-factor verification. Use an interactive first-admin bootstrap and no default credentials. Add and run tests/test_security.py after implementation for passwords, invalid/expired tokens and TOTP. [FR9, NFR1]
- [ ] Step 5 — Implement typed supplier adapters for selected Apify Actors, checking their actual public Actor input/output schema. Add free non-OpenAI web research and free card metadata tools. Preserve source URLs, fetched times, currency, printing, condition, language, exact-vs-reference prices and stock/unknown status. Do not call market reference prices purchasable offers or bypass site protections. Provider credentials, run errors and availability must be reported honestly; do not build an alternate fallback product. Add and run tests/test_suppliers.py after implementation with representative Actor fixtures and error cases. [FR2, FR3, NFR2]
- [ ] Step 6 — Implement deterministic equivalence, stock/quantity coverage, Decimal-based line totals and supplier/combined budgets. Unknown stock cannot establish full requested-quantity coverage; incompatible printings/conditions/languages are not silently matched; mixed currencies are grouped unless a verified conversion is supplied. Keep unknown shipping distinct from zero, product subtotal distinct from confirmed total, and never label incomplete coverage complete. Add and run tests/test_budget.py after implementation. [FR4–FR6, NFR2]
- [ ] Step 7 — Implement a LangGraph execution with LangChain models and tools: understand request, clarify material ambiguity, research a source-backed deck/card identity, validate deck quantity and format, retrieve supplier quotations, compare and explain. Persist graph progress and interruptions; bind resume actions to the authenticated execution owner. A full deck contains explicit card quantities and format validation, with unresolved rules shown rather than guessed. Supply sourced, dated legality/ban knowledge and refresh provenance; never hardcode an assumed current Standard rotation. Ask before substitutions, guide alternatives, and require explicit permission before retaining missing cards. Add and run tests/test_agent.py after implementation, including clear/ambiguous requests, continuation and missing-card permissions. [FR1–FR6, NFR2, NFR3]
- [ ] Step 8 — Implement auth, admin and orchestration API boundaries, consistent error responses and authenticated SSE progress/result streaming. Validate allowed models server-side on each invocation; model labels and provider API IDs are distinct and must be verified, never silently mapped to another model. Admin UI/API can configure verified API IDs for requested OpenAI family choices and mistral-medium-latest; surface credential/model unavailability honestly. Bound tool calls and propagate disconnect/cancellation/failure states. Add and run tests/test_api.py after implementation for tokens, admin enforcement, disabled models, ownership and SSE. [FR1, FR7–FR10, NFR1, NFR3]
- [ ] Step 9 — Implement the Cloudscape React chat: AppLayout/navigation, ChatBubble and PromptInput where supported by the installed API, model Select, card Cards with images/codes and source links, deck and budget Tables, progress StatusIndicator/ExpandableSection, clear clarification and substitution controls, and TOTP settings. Define a fixed typed event/component contract; never render model-produced executable markup. Stream via authenticated fetch SSE parsing; keep tokens out of URLs. Add data-testid to interactive elements. [FR1, FR5–FR9, NFR2–NFR4]
- [ ] Step 10 — Implement a separate Cloudscape admin-portal entry and container for account creation and enabled model administration; reuse shared client/auth/components without duplicating business rules. Add and run frontend/src/__tests__/chat.test.tsx and frontend/src/__tests__/admin.test.tsx after implementing the UI for streamed cards, keyboard-accessible actions, missing-card consent and admin model controls. [FR7–FR9, NFR1, NFR4]
- [ ] Step 11 — Create service Dockerfiles, compose.yaml, reverse-proxy configuration and service health checks. Use distinct environment/secret files and private networks, make local startup reproducible, and ensure backend streaming reaches the browser. Do not expose service ports unnecessarily or mount .env into runtime containers. Check docker compose config without displaying expanded secrets. [FR7, FR9, FR10, NFR1, NFR3]
- [ ] Step 12 — Install dependencies, run the planned Python and frontend tests, TypeScript checks and builds, and build/start Compose locally where available. Run permitted schema provisioning and dedicated-schema persistence checks when credentials allow; record remote integration limitations precisely. Run a browser smoke test for real login/chat/admin behavior when an initial account can be established securely. Do not claim live model/supplier success from mocks, health checks or an image build. [FR1–FR10, NFR1–NFR4]
- [ ] Step 13 — Redesign the shared login in frontend/src/Login.tsx and Shell.tsx with structural frontend/src/login.css, following the referenced project's 2:1 full-height split layout, dark gradient branding panel, quiet decorative background, centered compact Cloudscape sign-in card, helper copy and responsive stacked layout at narrow widths. Keep this app's username-based OAuth2/JWT and TOTP behavior; avoid importing the reference project's account data or authentication contracts. Use this app's Pokémon TCG branding. Verify existing frontend tests (including TOTP), TypeScript and build. Update the existing browser helper's login heading selector if needed, then run a targeted real browser check using scripts/login_visual_check.mjs with desktop/mobile screenshots, actual chat/admin login and overflow checks. Rebuild/recreate web and admin-portal containers and visually inspect both viewport sizes. [FR7, FR9, NFR4; user request 5b2b0886]
- [ ] Step 14 — Finish all preceding implementation and verification, then stop and ask the requester to participate in FIDO2 testing with both a key manager and a physical security key. Do not implement the physical-key portion earlier, invent the requester response, or present unattended tests as physical-key evidence. [FR9, user instruction]
- [ ] Step 15 — After the requester is ready, implement FIDO2/WebAuthn registration and authentication using a maintained library, single-use expiring challenges, verified origin/RP ID, user-presence/user-verification requirements, stored credential ownership and signature-counter handling. Add tests/test_webauthn.py and corresponding Cloudscape controls; run automated negative-path checks and record actual outcomes. The remaining interactive key-manager and physical-key verification is in Step 18 after the requested onboarding/recovery refinement. [FR9, NFR1, NFR4]
- [ ] Step 16 — Implement mandatory first-login 2FA enrollment before chat or administration, using purpose-bound limited enrollment sessions accepted only by enrollment endpoints. Confirm TOTP or WebAuthn before completing setup, keep normal API authorization unavailable while setup is incomplete, and preserve existing enrolled credentials. Provide the Cloudscape onboarding flow and meaningful API/UI tests in tests/test_onboarding_recovery.py and frontend/src/__tests__/onboarding.test.tsx. Run existing relevant tests and add negative cases for enrollment-token use against normal APIs, unconfirmed/expired enrollment, account state changes and races. [FR9a, NFR1, NFR4; user messages ae21a75f, 3082879a]
- [ ] Step 17 — Implement single-use recovery codes as a password-plus-second-factor alternative. Generate secure random codes during initial confirmed 2FA setup and allow authenticated regeneration that replaces the previous set; require the current password for regeneration. Show plaintext once with a save/download action, store only salted hashes, bound attempts, atomically consume codes with their password challenge, and prevent account/purpose/replay/session bypass. Recovery does not reset passwords or remove enrolled authenticators. Add and run backend and frontend recovery tests, including simultaneous use, invalidation on regeneration, used/incorrect codes, disabled accounts and secret redaction. [FR9b, NFR1, NFR3, NFR4; user messages ae21a75f, b57e1dbc]
- [ ] Step 18 — Verify the new-account flow through actual Docker/browser APIs: no application access before enrollment, confirmed setup and code-save UI, fresh 2FA sign-in, recovery use and replay rejection, and multiple named authenticators without removing existing ones. Keep automated virtual-authenticator checks separate from actual device evidence. Finish the interactive phone Google Password Manager and physical FIDO2-key registration/sign-in tests with the requester last, recording only observed/user-confirmed outcomes. Preserve the real administrator's existing credentials and never capture its plaintext recovery codes in logs/screenshots/chat. [FR9a–FR9c, NFR1, NFR4]
- [ ] Step 19 — Complete code-summary.md, unit-test-instructions.md and traceability.json, documenting startup/bootstrap/model configuration, service contracts, migrations, test results and any unverified integration. Obtain the declared independent code/design review only after these outputs exist; stop at the stage completion question. [FR1–FR10, FR9a–FR9c, NFR1–NFR4]

## Verification commands and dependency installation

Use python3 -m venv .venv and .venv/bin/python -m pip install -e '.[test]' after pyproject.toml exists. Install frontend dependencies using npm install in frontend/; generated package locks are part of this implementation. Optional browser smoke tooling may use the preinstalled Playwright tooling or a project-local Playwright dependency recorded in package.json. Docker image builds and Compose provision/start commands are authorized parts of Steps 11–12. Never output .env values or expanded Compose secrets.

The exact scoped checks and mocking policy are in unit-test-instructions.md. There is no numerical coverage floor in this PoC. Each FR/NFR needs a meaningful check; mocks test logic and do not verify live supplier retrieval or model access.

## Sources

- Requirements and planning clarifications cited above.
- https://cloudscape.design/llms.txt — Cloudscape package, global styles and React component documentation.
- https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/ — app-managed token flow chosen by the requester.
- https://docs.langchain.com/oss/python/langgraph/interrupts — persisted pause/resume behavior.
- https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post — Actor execution/data API.

## Testing Contract

```json
{
  "version": 1,
  "methodology": "test-after",
  "source": "org",
  "ordering": "implement each applicable testable layer, then write and run that layer's tests.",
  "scope": "poc",
  "test_strategy": "minimal",
  "project_type": "greenfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nBuild and Test verifies defined coverage floors and affirmed quality targets;\nthey may not be weakened to make a step pass.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    }
  ],
  "obligations": {
    "strategy": "minimal",
    "strategy_volume": [
      "One verifiable test per requirement at the narrowest effective level.",
      "At least one happy-path unit test per component.",
      "Unit tests are the default; a bugfix/security scope floor may require an integration or E2E regression when that is the narrowest level that reproduces the defect."
    ],
    "scope_floor": [
      "Keep the existing test suite green.",
      "This scope adds no extra new-test floor beyond the selected test strategy."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "test-after",
    "runner_step": "Bootstrap the minimal test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Bootstrap the minimal test runner/configuration and record the exact unit-scoped command.",
      "Data model / database behavior - implement.",
      "Data model / database behavior - write and run its tests after implementation.",
      "Repository / data access - implement.",
      "Repository / data access - write and run its tests after implementation.",
      "Business logic - implement.",
      "Business logic - write and run its tests after implementation.",
      "API / endpoint - implement.",
      "API / endpoint - write and run its tests after implementation.",
      "Frontend behavior - implement.",
      "Frontend behavior - write and run its tests after implementation.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:c5db1280ba0333b655bcf97bdcaeaa0fd9cc0f50807a6ee879935b8aff3e17e0",
  "contract_sha256": "sha256:be5041ec2297dded1a31f328fae6a86555cf649f231018ea8168c9bb8dd811a5"
}
```


