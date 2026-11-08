# CI/CD for the testing deployment

The Test workflow runs Python, frontend and container checks on pushes to
`main`, pull requests, and when called by a deployment. Deploy Heroku and Deploy
Cloudflare Pages are separate manual workflows on `main`; each invokes the Test
workflow for the same commit before deploying. Deploy Heroku builds the current source with Heroku Python buildpacks, releases
auth, chat, and admin sequentially, and scales each to one Eco web dyno. Deploy Cloudflare
Pages builds and uploads both frontends. The deployments are not atomic; a failed
or partially completed release needs investigation and an explicit rerun or rollback.

## One-time provider setup

1. Create three Cedar-generation Heroku apps with the heroku-24 stack and Eco web
   dynos. Set their app names as GitHub `testing` environment variables
   `HEROKU_AUTH_APP`, `HEROKU_CHAT_APP`, and `HEROKU_ADMIN_APP`.
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

Set secrets as Heroku config vars, never source control or workflow logs. Each
service needs its own restricted `DATABASE_DSN` for the existing application
schema. Do not supply the admin database connection string to any runtime app.
Existing `.runtime/*.env` files contain the local role connection strings and
must be handled privately. Provision or migrate explicitly through the existing
app-only provisioner; CI does not use database administrator credentials.

| App | Required runtime configuration |
| --- | --- |
| All | `SERVICE_NAME` (`auth`, `admin`, or `orchestrator`); its own `DATABASE_DSN`; `CORS_ORIGINS=https://chat.tcg-marketplace.02labs.me,https://admin.tcg-marketplace.02labs.me` |
| Auth | `JWT_PUBLIC_KEY`, `JWT_PRIVATE_KEY` (full PEM strings), `TOTP_KEY`, `WEBAUTHN_RP_ID=tcg-marketplace.02labs.me`, `WEBAUTHN_ORIGIN=https://chat.tcg-marketplace.02labs.me,https://admin.tcg-marketplace.02labs.me` |
| Admin | `AUTH_URL=https://api.auth.tcg-marketplace.02labs.me`, `ORCHESTRATOR_URL=https://api.chat.tcg-marketplace.02labs.me` |
| Orchestrator | `AUTH_URL=https://api.auth.tcg-marketplace.02labs.me`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `APIFY_API_KEY` as available |

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
preview Pages hostnames are deliberately not trusted by CORS or WebAuthn. App
sessions are per frontend origin, so switching sites requires signing in again.
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
