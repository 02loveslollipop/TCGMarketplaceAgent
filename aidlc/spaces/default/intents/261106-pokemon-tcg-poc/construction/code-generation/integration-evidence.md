# Integration Evidence

## Environment checks

Checked 2026-11-06 without printing secret values.

- Docker Engine reports 29.9.2 and Docker Compose reports v5.6.1.
- The original root .env defines OPENAI_API_KEY, MISTRAL_API_KEY and EXTERNAL_JDBC_POSTGRES_URI_ADMIN. The requester subsequently added APIFY_API_KEY for application use in message a78bfa54. The connected chat MCP session is separate from application credentials.

## Apify runtime authentication

After the requester added APIFY_API_KEY, an authenticated GET https://api.apify.com/v2/users/me returned HTTP 200. The response body and key were not printed or stored. This confirms runtime-key authentication; no Actor was started and no supplier data was retrieved.

## Provider model discovery

Read-only authenticated requests to official provider APIs returned HTTP 200:

- GET https://api.openai.com/v1/models returned gpt-6-luna and gpt-6.1-terra among the available model IDs.
- GET https://api.mistral.ai/v1/models returned mistral-medium-latest among the available model IDs.

Model discovery verifies that these IDs are listed for the supplied keys. It does not establish successful inference or a complete agent run. No secret values are included here.

## Minimal inference checks

Separate authenticated Chat Completions requests asked only for the literal POC_OK reply, with a 128-token completion limit:

- gpt-6-luna: HTTP 200, response model gpt-6-luna, expected reply received, finish reason stop.
- gpt-6.1-terra: HTTP 200, response model gpt-6.1-terra, expected reply received, finish reason stop.
- mistral-medium-latest: HTTP 429. Model listing succeeded but successful inference was not established. Do not silently fall back to a different provider.

These are credential/model smoke checks, not a complete LangChain or purchasing-agent execution.

The implemented services.orchestrator.models.model_for was subsequently exercised through installed LangChain ChatOpenAI.invoke for both gpt-6-luna and gpt-6.1-terra. Both returned the expected POC_OK reply. This verifies the application model factory and SDK boundary for those two models; it does not establish the full purchasing workflow.

## Supplier contracts

Apify MCP fetch_actor_details retrieved input schemas and inferred output schemas for devcake/tcgplayer-data-scraper and phantom_coder/cardmarket-listings-scraper. The complete contracts are stored in actor-contracts.json. No Actor was run and no dataset was read.

TCGplayer returns product metadata with nested seller listings; its aggregate marketPrice is not a seller quote. Cardmarket consumes actual product URLs and returns individual offers. Its priceUsd conversion is not treated as sourced FX without verifiable conversion provenance. Inferred schemas describe observed shapes, not this project's verified live results.

The TCGplayer Actor's README advertises TLS fingerprint bypass via Chrome impersonation. This project forbids bypassing protections, and that Actor is not used.

A second read-only contract inspection found crawloop/tcgplayer-listings-scraper for the same requested supplier. Its input and inferred flat seller-listing output are stored in tcgplayer-alternative-contract.json. This implementation uses that Actor contract with proxies disabled to read logged-out public listing data; no login or technical block is bypassed. No live run of either supplier Actor has been verified.

## Free research tool checks

The implemented Research.search successfully returned six sources for a Mega Lucario ex/Toucannon deck query, including https://limitlesstcg.com/decks/345. Research.search_cards returned seven actual Mega Lucario ex printings from the keyless TCGdex API. These checks verify the free search/catalog boundaries; search results alone do not establish deck legality or exact purchasable stock.

## Live planner check and correction

The initial actual Planner.resolve check against gpt-6-luna failed because OpenAI's strict response schema rejected Pydantic's uri format on image_url. The implementation now selects function_calling for validated AgentPlan and Legality output. A standalone structured-output check and the complete planner check then succeeded.

For the request "Make a M Gardevoir EX deck", the live planner returned zero resolved cards and this question:

> Should I build a historical 2016-era M Gardevoir-EX list or a casual/unrestricted deck, and what language, condition, finish, and printing do you prefer?

This exercises the actual model/research/structured-planning boundary and demonstrates asking about material ambiguity. It does not validate the historical interpretation, a complete deck, supplier quotations, or browser streaming.

A separate bounded real full-deck smoke did not establish a completed deck: one attempt returned ValueError, and a diagnostic retry failed in the initial legality search with DDGSException (no results). The free-search failure exposed a missing error boundary in current-legality retrieval and was sent to the developer for correction. Successful fixture-based graph tests must be reported separately from these live outcomes.

The legality-search failure was subsequently handled as dated unverified knowledge with a regression test. In a further live planner diagnostic using explicitly unavailable legality knowledge, the request for an actual used Mega Lucario ex/Toucannon Standard list returned a clarification about prioritizing an existing Mega Lucario list, an existing Toucannon list, or a custom hybrid. It returned zero cards, two sources and sixteen network calls. This demonstrates a source-backed follow-up when the requested used list cannot be established; a completed live 60-card deck remains unverified.

## Docker and browser integration

All six runtime services were healthy after startup and remained healthy on the 2026-11-07 resume check. The requester authorized generating the first administrator; credentials were saved only in ignored .runtime/bootstrap-admin.json with mode 0600, without printing the password.

The real browser smoke completed all eight checks successfully:

- Cloudscape login page renders.
- Generated administrator can log in and access the admin portal.
- Model policy can be verified and enabled through the actual admin UI.
- Actual GPT 6 luna/LangGraph clarification streams into the Cloudscape chat.
- Conversation and assistant question persist in the dedicated PostgreSQL schema.
- A fresh login restores the pending clarification from chat history.
- The authenticated user can cancel the pending execution.
- The previous model enabled state is restored after the test.

The smoke logs no passwords, JWTs or request headers and revokes its test sessions on completion. Screenshots were visually inspected: output/playwright/login.png, admin.png and chat-clarification.png. This test used actual local containers, the shared database's dedicated schema and an actual model, without running supplier Actors.

The assembled automated checks before the pending card-number normalization refinement passed 30 Python tests and 7 frontend tests, plus TypeScript and the production frontend build. Dedicated-schema service-role write checks were rolled back; all three runtime roles were checked for absence of schema creation, role creation, database creation and superuser privileges. Repeat provisioning succeeded without modifying unrelated schemas or database-wide grants.

After the card-number normalization refinement on 2026-11-07, the assembled Python suite passed 42 tests, including 20 supplier/budget checks. Formats such as 001/165 and local ID 1 now compare correctly while retaining original source values, subset/promo prefixes and suffixes; malformed or different card numbers remain unmatched. The orchestrator alone was rebuilt/restarted and all six services remained healthy. The previous seven frontend checks and eight real browser checks are unchanged. Steps 1–12 are complete; FIDO2 implementation and its interactive tests remain pending requester readiness.

## Legality references

https://play.pokemon.com/en-us/resources/rules/ was readable. It explains regulation marks, legal reprints and errata. A request to the 2026 rotation announcement on pokemon.com returned an iframe-only shell, which is not usable proof of current Standard rotation. Application retrieval must distinguish actual rule text from inaccessible pages and retain source and retrieval date.

## UI reference

https://cloudscape.design/llms.txt was checked for current React package names, global styles and component documentation. Implementation should use the installed component types to confirm API details.

## Requested login revision — 2026-11-07

The requester asked to adapt the login from /home/zerotwo/coa-puroseka-heroku. That project's web/src/App.tsx, styles.css, main.tsx and existing login screenshot were inspected read-only. The shared Pokémon login now follows its full-height 2:1 split layout, dark gradient/decorative graph, centered compact Cloudscape form, public typography tokens and stacked layout below 900px. This application's username-based OAuth2/JWT and TOTP flow remain in use. The reference's body typography/visual-refresh baseline applies while the login is mounted and is restored on exit. No reference account data or authentication contract was imported.

The existing 7 frontend tests, TypeScript check and production build passed after the change, including the existing TOTP check. Only web and admin-portal were rebuilt/recreated. All six Compose services were healthy afterward.

The targeted node scripts/login_visual_check.mjs run passed all 12 checks against the actual local containers:

- Desktop chat and admin login at 1440px use the split layout.
- Chat login at 390px and 320px, and admin login at 390px, stack without horizontal overflow.
- Empty sign-in is disabled; unknown credentials return HTTP 401 with an explanatory error.
- The generated administrator can sign in to both portals using keyboard navigation and return to login on sign-out.
- No browser runtime exceptions occurred.

The helper reads generated credentials privately in-process, logs no secrets, revokes test sessions and performs no model or supplier calls. It waits for font readiness before screenshots. Final previews were inspected at output/playwright/login-redesign-desktop.png, login-redesign-mobile.png, admin-login-redesign-desktop.png and admin-login-redesign-mobile.png. An additional settled-page inspection confirmed the public Open Sans font stack on the body, heading and labels.

Step 13 is complete. FIDO2 and final stage completion remain pending the unanswered requester-participation checkpoint; this revision does not establish a completed PoC or any additional live supplier result.

## WebAuthn implementation and automated preflight — 2026-11-07

The requester confirmed readiness in message 2ee467bf and chose Google Password Manager on their phone in message 7cb09033. The maintained py_webauthn server library and SimpleWebAuthn browser library now implement password-first second-factor registration and authentication. Accounts can hold multiple named credentials. Origin and RP configuration are fixed server-side; user presence and verification are required. Purpose-bound expiring ceremonies are claimed with a committed atomic update before verification, and final issuance locks the password challenge, account and credential counter. Enrollment/removal revokes existing sessions; removing the last authenticator without an alternative is rejected. TOTP remains available when enrolled.

The assembled suite passed 63 Python tests, including 21 WebAuthn crypto/API tests with actual ES256 signatures, COSE public keys and CBOR attestation. The frontend passed 11 tests, including enrollment, cancellation, cancellation while options are loading, and second-factor choices. TypeScript, the production build and Compose configuration passed. Provisioning added only the app-owned WebAuthn tables/grants and auth configuration in the dedicated schema. Auth and the two frontends were rebuilt/recreated; other services were unchanged.

The actual Chrome/PostgreSQL preflight in scripts/fido_virtual_smoke.mjs passed eight checks using a virtual authenticator and a separate temporary user:

- Initial password login reaches authenticator settings.
- Browser-generated registration verifies and the previous access token is revoked.
- A password challenge cannot access an authenticated session.
- Cancelling a native ceremony consumes its server challenge; replay is rejected and a fresh attempt remains possible.
- Two simultaneous submissions of the same browser-generated signed assertion yield exactly one HTTP 200 and one HTTP 401.
- The verified assertion completes the password-first login in the browser.
- Removing the last authenticator without an alternative returns HTTP 409.
- Sign-out succeeds.

The first run exited nonzero only during fixture cleanup: the helper expected DATABASE_URL, whereas runtime credentials use DATABASE_DSN. The cleanup code was corrected, and recovery disabled exactly the one fixture account using the auth runtime role, a narrow creation-time window, the generated test-name prefix and its Virtual preflight credential. Its sessions were revoked. No other account was modified. This cleanup recovery is separate from the eight passed browser assertions; the entire helper was not rerun afterward.

These checks establish automated browser/service behavior, not Google Password Manager or physical-key participation. A separate headed Chrome window uses an ignored dedicated profile and loopback-only debugging. No virtual authenticator is enabled in that window. The initial real phone registration request has been opened; actual phone and physical-key registration/sign-in outcomes remain pending.

## Actual phone outcome and requested authentication refinements

The first phone request timed out while the requester was not watching (1041e367). The retry obtained fresh registration options with HTTP 200. The requester confirmed it worked in ae21a75f. The authenticated UI was subsequently observed with exactly one credential named Google Password Manager (phone), enrolled at 2026-11-07 07:56:43 local time. The separate phone assertion request was not captured by the browser helper; do not confuse the automated virtual assertion test with observed real-device participation. No physical-key registration/sign-in has yet been recorded.

The requester then asked to check first-login 2FA, add recovery keys and allow multiple enrolled keys (ae21a75f). Inspection confirmed that multiple named WebAuthn credentials are already supported, but unconfigured accounts currently receive a normal access token and recovery codes are absent. Follow-up answers require 2FA enrollment before chat/admin access (3082879a) and single-use recovery codes, shown once and stored only as hashes, used after the correct password (b57e1dbc). FR9a–FR9c and implementation steps 16–19 record those changes separately from the original Requirements Analysis approval. Implementation and new browser verification are in progress; the real saved phone credential is to be preserved.
# 2026-11-08 onboarding and recovery continuation

## 2026-11-08 supplier live probe

The requester authorized testing suppliers using publicly accessible logged-out pages and without treating internal store endpoints as public APIs. The existing service enables supplier adapters whenever its Apify credential is present; no separate enable flag was changed. A single Cardmarket Actor run used its public Blastoise ex 151/200 product page, English/NM filters, a 50-result limit, and disabled fair-value enrichment. It returned 50 parsed listing rows at 2026-11-08T07:49:22Z. The first rows had available quantity 1 and prices EUR 100, 107.50 and 110; shipping and printing were unknown. This is a point-in-time adapter probe, not a completed comparable budget. Actor output appended URL filter parameters and used the name `Blastoise ex (MEW 200)`, so the adapter's exact URL/name identity check did not bind the requested card number. As a result these rows cannot presently pass the app's comparison rules for that requested card. The supplier and budget unit suites passed 25 tests but did not expose that live shape.

The TCGplayer Actor was not run: its public documentation describes reading marketplace JSON used by the website, which must not be assumed to be a public API. A direct public product page could not be fetched by the web tool. No two-supplier budget was verified. An Apify token was accidentally exposed in tool output during the check; its value is intentionally omitted here and rotation is required. Supplier runtime access was not changed, so the configured TCGplayer Actor remains a potential call path whenever an Apify credential is configured.

## 2026-11-08 browser deck journey

A real in-app Chromium run used a disposable administrator, temporarily enabled GPT 6 luna, and supplied the published `https://play.limitlesstcg.com/tournament/best-mega/player/c1nd3rjace/decklist` list. The orchestrator was temporarily recreated with Apify credentials withheld: the TCGplayer Actor's internal-endpoint behavior and the Cardmarket identity mismatch remain unresolved. Consequently this was not an end-to-end live supplier-price test.

The first execution failed mid-research with an `OperationalError`; its underlying database cause was not recorded in the available service logs. A retry fetched the deck source, searched card metadata, completed the batch lookup, rendered 21 distinct card entries totaling 60 cards, and matched the source by names and quantities: 16 Pokémon, 33 Trainers, and 11 Fighting Energy. It cited the tournament page and TCGdex records, marked current format legality unverified, and displayed the missing-card decision for all 60 cards. After explicit test consent to retain them, it rendered the final result with no offers; no total or purchasing budget was verified. The source deck's own record reports 3 wins and 3 losses, not a tournament win. The generated finish preference `any matching gameplay text` is not the literal `any` accepted as a wildcard by `budget.equivalent`; this may make live comparisons incorrectly reject offers and needs a targeted regression and fix.

The GPT 6 luna policy was restored to disabled and unverified, the disposable account disabled and demoted with its sessions revoked, and the original orchestrator configuration restored; all six services reported healthy. The running orchestrator's supplier module differs from the current workspace file: the image still contains the earlier supplier-permission guard. This live run therefore cannot validate the current on-disk supplier implementation.

The application-only provisioner completed using the existing runtime role credentials; `scripts.check_database` passed restricted-role and own-schema persistence checks for auth, admin and orchestrator, rolling back its verification rows. The rebuilt six-service Compose stack reported healthy.

The scoped Python suite passed 77 tests. The React suite passed its 11 existing tests and six new onboarding/recovery tests. The frontend production build passed with a large-bundle advisory. The new test file covers restricted first login, TOTP and WebAuthn setup, unsuccessful/expired setup, saved-code gating and download, password-confirmed regeneration and recovery login rejection/success.

`node scripts/onboarding_recovery_smoke.mjs` passed ten checks against the running services and PostgreSQL, using disposable accounts and virtual authenticators; its cleanup succeeded. It checked enrollment restrictions, TOTP setup and fresh login, one-time recovery display/download, recovery replay and concurrent recovery-code consumption, code regeneration and session revocation, and two named WebAuthn credentials including subsequent use of the original. The three fixture screenshots were visually inspected; the recovery code image was masked.

`node scripts/onboarding_recovery_smoke.mjs --enrollment-race` separately raced two confirmations for one TOTP setup. Exactly one succeeded and its disposable fixture was disabled. Neither browser run establishes real phone or physical-key behavior. Existing administrator authenticators were not changed.

# Real-device continuation

The requester completed the phone second factor and the application reported an authenticated session. After the session was accidentally cleared by a page navigation, the requester repeated the phone sign-in and the authenticated state was verified again. They then registered a physical key; the UI reported an authenticator change and required sign-in again. After the requester reported signing in with the physical key, the application again showed an authenticated session. The settings table showed exactly two entries, the original `Google Password Manager (phone)` and `Physical security key`. Device selection and PIN/touch were handled by the requester; no assertion transaction was independently captured for either real device.

A browser snapshot unexpectedly included an autofilled administrator password in tool output. Avoid sharing that output; coordinate credential rotation with the requester after device testing. No reset, credential deletion or password rotation was performed.

At the requester's explicit instruction, new administrator recovery codes were generated and saved without logging their contents to a mode-0600 file under the ignored `.runtime/` path. The acknowledgement was completed and the app returned to the sign-in screen. The requester plans to remove this account and create a replacement later; neither action was performed here. The workspace is not a Git repository, so `git check-ignore` cannot establish ignore behavior; `.gitignore` lists `.runtime/`.

