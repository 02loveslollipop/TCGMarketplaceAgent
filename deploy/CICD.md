# CI/CD for the testing deployment

The Test workflow runs Python, frontend and container checks on pushes to
`main`, pull requests, and when called by a deployment. Deploy Heroku and Deploy
Cloudflare Pages are separate manual workflows on `main`; each invokes the Test
workflow for the same commit before deploying. Deploy Heroku builds the current source with Heroku Python buildpacks, releases
auth, ddg_mcp, chat, and admin sequentially (the MCP server goes live before the
orchestrator that calls it), scales each to one Eco web dyno, and then checks each
app's `/health` endpoint on its Heroku `web_url`. Deploy Cloudflare
Pages builds and uploads both frontends. The deployments are not atomic; a failed
or partially completed release needs investigation and an explicit rerun or rollback.

## One-time provider setup

1. Create four Cedar-generation Heroku apps (`auth`, `ddg_mcp`, `chat`, and
   `admin`) with the heroku-24 stack and Eco web dynos only. Set their app names as
   GitHub `testing` environment variables `HEROKU_AUTH_APP`, `HEROKU_MCP_APP`,
   `HEROKU_CHAT_APP`, and `HEROKU_ADMIN_APP`.
2. Create two Cloudflare Pages Direct Upload projects with production branch
   `main` and set `CLOUDFLARE_CHAT_PROJECT` and `CLOUDFLARE_ADMIN_PROJECT` in
   the same GitHub environment. Set `CLOUDFLARE_ACCOUNT_ID`. Direct Upload
   projects cannot later be converted to Git integration.
3. Add `HEROKU_API_KEY` and `CLOUDFLARE_API_TOKEN` as GitHub `testing`
   environment secrets. The Cloudflare token needs Account / Cloudflare Pages /
   Edit for the 02Labs account. The Heroku direct authorization uses identity/read/write
   scope across the owner's apps; it cannot be limited to just these apps with
   that personal scope. Treat it accordingly, and revoke it when no longer needed.
   The local `.env` is not uploaded to GitHub Actions.
4. Configure Heroku runtime config separately (below), and configure the two
   Pages custom domains. Add each Heroku custom domain, use DNS-only CNAMEs for
   the Heroku endpoints and enable ACM per app (`heroku certs:auto:enable`).
   Pages custom domains are added to their Pages projects and use Pages-managed
   certificates. Confirm DNS and certificate status for each actual hostname.
5. After everything is configured, run Actions → Deploy Heroku, followed by
   Actions → Deploy Cloudflare Pages, selecting `main` for each. Check Heroku releases, health endpoints,
   certificates and both browser flows. A green CI run does not replace those
   end-to-end checks.

## Runtime configuration

Set secrets as Heroku config vars, never source control or workflow logs. The
`auth`, `admin`, and `orchestrator` services each need their own restricted
`DATABASE_DSN` for the existing application schema and the shared `CORS_ORIGINS`.
Do not supply the admin database connection string to any runtime app.
The `ddg_mcp` service (`SERVICE_NAME=ddg_mcp`) is stateless: it never receives a
`DATABASE_DSN` or `CORS_ORIGINS`, and is called only server-to-server by the
orchestrator over its default Heroku HTTPS domain (`https://<app>.herokuapp.com/mcp`),
so no custom domain or DNS record is needed for it. It requires `MCP_AUTH_TOKEN`
(a strong random bearer token shared only with the orchestrator) and rejects
unauthenticated `/mcp` requests with HTTP 401.
Existing `.runtime/*.env` files contain the local role connection strings and
must be handled privately. Provision or migrate explicitly through the existing
app-only provisioner; CI does not use database administrator credentials.

| App | Required runtime configuration |
| --- | --- |
| Auth, Admin, Orchestrator | `SERVICE_NAME` (`auth`, `admin`, or `orchestrator`); its own `DATABASE_DSN`; `CORS_ORIGINS=https://chat.tcg-marketplace.02labs.me,https://admin.tcg-marketplace.02labs.me` |
| Auth | `JWT_PUBLIC_KEY`, `JWT_PRIVATE_KEY` (full PEM strings), `TOTP_KEY`, `WEBAUTHN_RP_ID=tcg-marketplace.02labs.me`, `WEBAUTHN_ORIGIN=https://chat.tcg-marketplace.02labs.me,https://admin.tcg-marketplace.02labs.me` |
| Admin | `AUTH_URL=https://api.auth.tcg-marketplace.02labs.me`, `ORCHESTRATOR_URL=https://api.chat.tcg-marketplace.02labs.me` |
| Orchestrator | `AUTH_URL=https://api.auth.tcg-marketplace.02labs.me`, `DDG_MCP_URL=https://<ddg_mcp-app>.herokuapp.com/mcp`, `MCP_AUTH_TOKEN` (same value as the ddg_mcp app), `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `APIFY_API_KEY` as available |
| DDG MCP | `SERVICE_NAME=ddg_mcp`, `MCP_AUTH_TOKEN`; optional `DDG_SEARCH_BACKEND` (default `auto`), `DDG_FETCH_BACKEND` (default `auto`), `DDG_SAFE_SEARCH` (e.g. `MODERATE`), `DDG_REF_URL_THRESHOLD` (default `0`). No `DATABASE_DSN`. |

`APIFY_LIVE_SCRAPE` explicitly controls live seller-listing retrieval (default `false`). An API key alone does not enable it. The current testing deployment keeps it disabled: baseline price-guide estimates are available, but seller stock is unverified. Every execution records this disabled outcome separately from blocked access, empty datasets, transport errors and confirmed listing shortfalls. Set it to `true` only when live Apify actor runs are intended; those runs may incur provider usage charges.

The Heroku buildpack uses `requirements.txt`, `.python-version`, and `Procfile`.
The deploy workflow sends a minimal, history-free source snapshot to each Heroku
app, keeping the app deployment independent of the repository history.

The Heroku entrypoint refuses the local password-only development mode. Its
`PORT` is supplied by Heroku. PEM values can contain newlines; preserve them
when setting config vars. Keep the existing JWT and TOTP keys if retaining
accounts and authenticator secrets, and preserve the existing role credentials.
The previously enrolled localhost passkey is tied to RP ID `localhost` and
cannot authenticate at the new domain. Before switching, ensure the account has
another usable recovery method and enroll a new passkey for the new RP ID.

The browsers call the APIs on their own domains with CORS; both frontend origins
must be explicitly allowed. The frontend builds use the five hostnames above;
preview Pages hostnames are deliberately not trusted by CORS or WebAuthn. After
sign-in, each portal registers its session with the auth service through
`POST /api/auth/portal-session`, which stores the short-lived access token in a
host-only, `HttpOnly`, `Secure`, `SameSite=Strict` cookie on the auth API. When an
administrator opens the other portal (`chat` ↔ `admin`), it restores that
authenticated session through `GET /api/auth/portal-session` (origin-checked
against `CORS_ORIGINS`) without signing in again, until the token expires.
Validate Heroku request/stream timeouts and cold-start behavior with a real deck
request before depending on the testing deployment.

## References

- https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/pages/configuration/custom-domains/
- https://devcenter.heroku.com/articles/container-registry-and-runtime
- https://devcenter.heroku.com/articles/automated-certificate-management
- https://devcenter.heroku.com/changelog-items/2728
- https://devcenter.heroku.com/articles/oauth
