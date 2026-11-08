# Code Summary

## Application

The private PoC provides Cloudscape React chat and administration portals, FastAPI authentication and administration services, and a LangGraph/LangChain orchestration service streaming progress and structured results over authenticated SSE. A gateway exposes the local interfaces. Service-specific database roles operate only in the `pokemon_tcg_poc` schema; provisioning alone receives the administrative connection. Startup and bootstrap instructions are in `deploy/README.md`.

Authentication uses OAuth2 password exchange, Argon2id password hashes, JWT sessions, TOTP and WebAuthn. New accounts must enroll a second factor before access. Named WebAuthn credentials and password-confirmed, one-time recovery codes are supported.

The opt-in `LOCAL_DEV_PASSWORD_ONLY=true` Compose switch allows active accounts to sign in with a correct password without 2FA for local development. It defaults to false and does not change enrolled factors. Password-only JWTs are bound to one auth-service instance and are rejected after restarting or disabling this mode; other services validate sessions through auth. Usage and security implications are documented in `deploy/README.md`.

Research uses free search and card metadata tools. Supplier adapters retain provenance and reject insufficient product information. Budgets separate currencies, product subtotals and unknown shipping. Live supplier retrieval has not been exercised in the automated suite and no live supplier quotation is claimed.

Budget allocation now maximizes the number of requested units covered before minimizing the product subtotal for that coverage, within each supplier/currency option. This prevents a flexible request from consuming the only inventory compatible with a stricter request. Shipping remains separately reported and is not part of that optimization.

Missing coverage is tracked by normalized card identity and restrictions, rather than card ID alone. Condition aliases and equivalent card-number formats merge; the original restrictions accompany missing results and consent. Top-level missing coverage uses the highest-coverage single-currency combined alternative, with a deterministic currency-order tie, rather than combining incompatible budgets.

Final budget lines and missing quotations show set, number, condition, language and printing when available, distinguishing variants even when they share a card ID. Older results without those fields show that variant details are unavailable; purchase links remain attached to their respective rows.

## Verification

- The full scoped Python suite passed 77 tests. React tests passed 11 existing tests and six onboarding/recovery tests; TypeScript and the production build passed, with Vite's large-bundle advisory.
- After the allocation repair, the budget, agent and API test files passed 19 tests, including flexible versus Near Mint requests, maximum coverage and minimum product subtotal.
- After the identity repair, those same three test files passed 23 tests, including shared-ID variants, alias merging, currency separation and the agent's scoped consent interruption.
- After the final-results revision, all three frontend test files passed 20 tests and the TypeScript/Vite production build passed; Vite continues to report its large-bundle advisory.
- For local password-only mode, the affected auth, API, WebAuthn and recovery checks passed 47 tests; the API file with the subsequent added cross-service introspection regression passed seven tests. Compose configuration validation passed. This mode has not yet been enabled or tested against the running stack.
- Application-only provisioning succeeded. All three restricted roles passed application-schema persistence checks, with verification rows rolled back. Six rebuilt Compose services reported healthy.
- A real browser against the services and PostgreSQL passed ten disposable-account checks for restricted onboarding, TOTP, recovery generation, replay and concurrent recovery use, replacement and session revocation, and two virtual authenticator credentials. Fixture cleanup succeeded. A separate live concurrent enrollment confirmation test succeeded exactly once and cleaned up its fixture.
- Separately, after the requester reported phone sign-in and physical-key sign-in, each resulting authenticated state was observed. Both named credentials remained present. The browser assertion transactions were not independently captured; the user's device selection and touch were private.
- Earlier integration evidence and the limitations of provider and supplier checks are recorded in `integration-evidence.md`; they do not establish a completed live deck purchase or supplier coverage.

## Remaining work

At the requester's instruction, administrator recovery codes were saved to a private mode-0600 file under `.runtime/`; their contents were not printed or captured in screenshots. An autofilled administrator password appeared in tool output during verification. The requester plans to replace this account later; no account deletion or password rotation was performed. Complete the stage review after recording any remaining outcome.
