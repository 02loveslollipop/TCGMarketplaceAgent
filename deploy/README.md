# Local private PoC

Python 3.11+, Node 24, Docker and Docker Compose are required. PostgreSQL is the
existing external database; the application never starts another database or
connects to another project's schema.

From the workspace root:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m scripts.provision
.venv/bin/python -m scripts.check_database
.venv/bin/python -m scripts.bootstrap_admin
docker compose config --quiet
docker compose up --build -d --wait
```

The bootstrap command prompts privately for the person's username/password. There
is no default account and no self-registration. Sign in at
http://localhost:8080/ or http://localhost:8080/admin/. The admin portal enables
models only after verifying their actual provider API ID. The requested presets
are `gpt-6-luna`, `gpt-6.1-terra` and `mistral-medium-latest`; enabling a registry
entry never guarantees inference quota. There is no automatic model replacement.

### Standalone API tester Docker deployment

This is an alternative to the full Compose stack and the hosted Pages portals.
It starts only a non-root Node24 container containing the API tester and a
same-origin HTTP/SSE proxy. It uses existing auth/chat services, their IAM roles
and their per-principal quotas. It does not provision a database or restart the
existing application. Python3.11+ and Docker are sufficient on the host; Node and
frontend build dependencies run inside Docker.

```sh
python -m scripts.api_tester up --default --token "$TCG_API_TOKEN"
# Open http://127.0.0.1:8090/api-test/
python -m scripts.api_tester down
```

`--default` selects the deployed Heroku APIs at
`https://api.auth.tcg-marketplace.02labs.me` and
`https://api.chat.tcg-marketplace.02labs.me`. Omitting both the flag and custom
URLs keeps the same defaults. Use `--auth-url` and `--chat-url` instead of
`--default` to select custom services; combining them is rejected to avoid
ambiguous routing. Base URLs point at the service root,
or include `/api/auth` and `/api/chat` when using a gateway. The container proxies
auth session introspection and agent endpoints, so no CORS changes are required.
It strips cookies in both directions, never supplies a server-side fallback
credential, streams responses without buffering, and closes the upstream request
when the browser disconnects. TLS verification remains enabled.

Use `--token-stdin` to keep the token out of process arguments as well:

```sh
printf '%s\n' "$TCG_API_TOKEN" | python -m scripts.api_tester up --default --token-stdin
```

The launcher transfers the token through `docker exec -i` stdin into a mode0600
temporary file on container tmpfs, never a build argument, image layer, Docker
environment variable or URL. The frontend consumes it once through a no-cache,
same-origin bootstrap request, which removes that file, then authenticates as
the API principal through the ordinary tester transport. After consumption it
is held only in browser memory. Reloading, disconnecting or restarting requires
manual token entry or a new launch. The launch token must already exist; this
command does not create or revoke credentials. An invalid/expired token shows
the normal connection error. Browser storage stays disabled.

The port binds to `127.0.0.1` only. Open the exact printed URL, since the proxy
checks its origin and Host. Keep this private testing container local; it does
not provide a public login or remote hosting layer. No extra CORS permissions
or bypass of IAM/2FA is introduced.

For the existing local Compose services, attach to their network explicitly:

```sh
python -m scripts.api_tester up --token "$TCG_API_TOKEN" \
  --network pokemon-tcg-poc_private \
  --auth-url http://auth:8000 --chat-url http://orchestrator:8000
```

`localhost` inside the container refers to the container itself. Use reachable
service names, a reachable gateway address, or the hosted HTTPS URLs. Set
`--port 8091` and `--name another-tester` for a separate instance; use the same
name for `down`. Existing containers are never replaced. `down` refuses to
remove containers without the launcher's ownership label. `--no-build` reuses
`tcg-api-tester:local`; `--image` selects another image tag and `--build-network`
overrides the Docker build network when needed by the host. The container has a
read-only filesystem, no added capabilities and a health check. Build failures
leave existing services unchanged; failed starts remove only the new container.

Standalone checks (no live model calls):

```sh
node --test tests/api-tester-server.test.mjs
.venv/bin/pytest -q tests/test_api_tester_cli.py
```

### Web search MCP service (`ddg-mcp`)

The Compose stack also runs `ddg-mcp`, a stateless DuckDuckGo search/fetch MCP
server (`services.ddg_mcp.main`) on the private network with outbound internet
access. It has no database access and is not exposed through the gateway. The
`orchestrator` reaches it over Streamable HTTP at `DDG_MCP_URL` (default
`http://ddg-mcp:8000/mcp`, written to `.runtime/orchestrator.env` by the
provisioner) and sends `Authorization: Bearer $MCP_AUTH_TOKEN`. When
`MCP_AUTH_TOKEN` is set in root `.env`, the provisioner copies it into
`.runtime/orchestrator.env` and Compose passes the same value to `ddg-mcp`, which
then rejects unauthenticated `/mcp` requests with HTTP 401. Optional
`DDG_SEARCH_BACKEND`, `DDG_FETCH_BACKEND`, `DDG_SAFE_SEARCH` and
`DDG_REF_URL_THRESHOLD` tune the search server. On Heroku it is a separate Eco app
(see `deploy/CICD.md`).

### Local password-only development mode

Two-factor authentication is required by default. For local development only,
the auth service can instead allow every active account to sign in with its
correct password, including accounts that already have authenticators. This
reduces account protection; use it only on a trusted local machine. Existing
authenticators and recovery codes are preserved. Enable the switch when creating
the auth container:

```sh
LOCAL_DEV_PASSWORD_ONLY=true docker compose up -d --build auth
```

To restore mandatory 2FA, recreate the service with the switch off:

```sh
LOCAL_DEV_PASSWORD_ONLY=false docker compose up -d auth
```

Password-only sessions are rejected after the service is recreated, including
if development mode is subsequently re-enabled. Normal 2FA-verified sessions
remain subject to their ordinary expiry and revocation rules. Authenticated
requests to the other services are checked against the auth service. The
switch is a Compose environment override; it does not require changing `.env`
or granting any database privileges.

When explicitly authorized to generate initial PoC credentials, run
`.venv/bin/python -m scripts.bootstrap_admin --generate` instead of the interactive
bootstrap command. It creates a unique administrator and strong random password,
writes them only to ignored `.runtime/bootstrap-admin.json` with mode0600, and
prints the username and file path without printing the password. Both bootstrap
modes refuse to create another initial account if an administrator already exists.
The generated account used for this PoC is recorded in that private local file;
read it locally rather than copying credentials into chat or command arguments.

The provisioner alone reads root `.env` and its
`EXTERNAL_JDBC_POSTGRES_URI_ADMIN`. It creates `pokemon_tcg_poc` and three restricted
service roles, reuses existing restricted roles and privately held credentials on
later runs, and seeds disabled model entries. It refuses elevated existing roles
or an existing app schema owned by someone else. `.runtime/` is mode 0700, its
files mode 0600. Containers run as UID 1000 for this local environment, matching
the owner of generated secrets; adjust container UID consistently on another host.
Never commit `.env` or `.runtime/`. Restoring existing roles after loss of runtime
credential files requires an administrator's credential recovery; passwords are
not rotated automatically. Do not grant application roles schema ownership,
schema creation or privileges in other projects' schemas.

Only the orchestrator receives OpenAI, Mistral and Apify credentials. `APIFY_API_KEY`
is primary, with `APIFY_TOKEN` accepted as an alias. APIs/services are private to
Compose; only the gateway binds to `127.0.0.1:8080`. Root `.env` is excluded from
Docker build contexts and is not mounted into runtime services. The optional
`setup` profile may rerun provisioning after host initialization creates the
runtime folder, using `docker compose --profile setup run --rm provision`.

Live supplier retrieval requires `APIFY_LIVE_SCRAPE=true` and `APIFY_API_KEY` (or
`APIFY_TOKEN`). Otherwise the adapter can retrieve TCGdex price-guide references
from both marketplaces. References have unknown stock, condition, and language;
they never satisfy purchase coverage or produce a confirmed budget. The live
adapter uses `crawloop/tcgplayer-listings-scraper` with proxies
disabled and `phantom_coder/cardmarket-listings-scraper` with paid fair-value
enrichment disabled. Both Actors read publicly accessible, logged-out listings;
do not bypass a login, paywall, CAPTCHA or other technical block, and collect no
personal data beyond public seller display names. The devcake Actor is never
executed.

Cardmarket output lacks a printing number and finish. It becomes comparable only
when exact product identity is bound to retrieved, matching source evidence, and
the user explicitly allows any finish; otherwise missing fields remain unknown.
TCGplayer rows likewise require actual card numbers and matching variants.
Card-number comparison normalizes local numerators such as `001/165` and `1`
without discarding promo/subset prefixes or alternate-card suffixes; the original
supplier number remains in the offer provenance. Malformed or different numbers
remain non-comparable, and equivalent number formats share inventory allocation.
Reference market values never become purchasable listings. Budgets allocate stock
once, separate currencies and product/shipping totals, and retain missing cards
only after explicit consent scoped to the displayed missing set.

Deck requests pause after card review and before supplier pricing. Approve the
displayed deck to continue, request changes to generate a revised review, or
cancel. A revision or researched substitution requires a fresh approval. The
final artifact is the buying budget, with separate price-guide estimates when
seller quotations cannot establish coverage. Headless runs must explicitly pass
`--approve-deck` to approve generated decks automatically.

Agent preferences are available from the chat navigation settings action and
the account menu. Ruleset and format retain Auto options. Shopping location is
optional research guidance, never a hard supplier or card-language restriction.
Each execution keeps the preferences captured when it started.

Selecting a target currency makes converted estimates the primary price view;
original supplier amounts remain secondary and can be selected as the main view.
Exchange rates, their date, and attribution are displayed with the budget. The
server uses the free, keyless [ExchangeRate-API open endpoint](https://www.exchangerate-api.com/docs/free),
caches rates until the next update (up to 24 hours), and preserves original
prices if conversion fails. Totals use currency minor-unit precision, while
converted unit prices retain fractional precision for low-value cards. FX never
confirms stock, shipping, taxes, card issuer fees, or a final settlement amount.
No new API credential is required.

For an existing database, add the buying preference columns with
`python -m scripts.provision --migrate-preferences` before running the updated
services. This idempotent command modifies only `pokemon_tcg_poc.user_preferences`
and preserves existing preferences, accounts, credentials, and runtime files.

The LangGraph uses SQL-backed checkpoints in `pokemon_tcg_poc.graph_checkpoints`.
It stores the latest checkpoint per execution, including human interruptions,
without offering time-travel history. Owner checks precede resume. Research has
bounded tools, up to60 cards per metadata batch, six parallel metadata requests,
and a 120-request research ceiling. Free search and authoritative legality sources
may be unavailable; results then retain a dated unverified-legality status.
Long research emits progress and SSE heartbeats. Disconnects cancel execution.
Access tokens default to eight hours (`ACCESS_TOKEN_TTL_MINUTES=480`). Browser
sessions renew while in use, with a seven-day absolute limit
(`MAX_SESSION_HOURS=168`); renewed tokens cannot extend past that limit.
Expired tokens can renew only within `REFRESH_GRACE_SECONDS` (default one day)
and only while their account, authenticator state, and token version remain valid.

New accounts must confirm an authenticator app or a passkey/security key before
they can use chat or administration. Setup shows recovery codes once; save them
privately before finishing and signing in again. An existing account can add
multiple named security keys and generate replacement recovery codes in its
settings. Replacement requires the current password, invalidates earlier codes,
and revokes existing sessions. A recovery code can be used once after the correct
password to recover the account. Recovery atomically removes all enrolled
authenticators, invalidates existing sessions, pending challenges and all old
recovery codes, and returns only a five-minute enrollment token. The account
holder must confirm a new authenticator and save new recovery codes before
signing in again. Recovery never directly grants access to chat or administration.

WebAuthn works only in a secure context; browsers treat localhost specially. The
default relying party ID is `localhost` and the origin is `http://localhost:8080`.
For use beyond localhost configure HTTPS termination and the correct
`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` before provisioning and testing. Automated
virtual-authenticator tests do not establish physical security-key behavior.
This repository does not claim public deployment.

Stop with `docker compose down`. This removes local containers/networks without
altering the external database or its application records.

### Role policies and daily token accounting

Before updating running services with these features, run the existing app-scoped
`scripts.provision` command. It adds `pokemon_tcg_poc.role_policies` and
`pokemon_tcg_poc.daily_token_usage` and grants the service roles only their needed
operations. Auth and admin also receive INSERT access to the app audit log for
role changes. This source update has been tested against isolated local PostgreSQL;
it does not itself migrate the shared database or deploy services.

Default daily allowances are 50,000 tokens per User account and 200,000 per
Administrator account. Administrators can edit either quota and its allowed model
list under Role access and quotas. A null model list inherits globally enabled
models; an empty list allows none. A quota of zero blocks new model calls. Role
changes do not reset a user's usage. Only globally enabled and role-allowed models
are listed or accepted by the orchestration API.

Input and output tokens are counted from provider response metadata around every
LangChain call, including tool reasoning and structured parsing failures. Reasoning
tokens already included in reported output are not added twice. A call is charged
to its start date in Asia/Tokyo, and allowances reset at midnight Japan time.
Responses already admitted may finish beyond the remaining quota. Concurrent
model calls for the same account are rejected so parallel requests cannot spend
the same remaining allowance. Stopping an agent stops subsequent work while its
admitted provider call finishes for usage accounting. Explicit provider rejections
(e.g. HTTP 429) release the admission without charging tokens. If usage cannot be
verified, or the process dies during a call, further calls for that day are blocked
rather than silently treating unknown usage as zero. Daily usage is visible in chat.

This is an LLM token budget, not a monetary limit on supplier tools or a proof
against prompt injection. Authorization and usage checks run on the server, outside
model output. Existing read-only tool restrictions and validated outputs still apply.

Run the usual Python/frontend checks for a local review. The additional concurrency
test is enabled with TEST_ROLE_POSTGRES_URL pointing to an isolated local PostgreSQL
database named `tcg_dashboard_test` on `127.0.0.1`; it recreates only this app's tables
in that disposable database. Never point it at the shared database.
