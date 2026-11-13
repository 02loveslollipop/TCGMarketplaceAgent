# Live agent evaluations and CI

The [13 November 2026 validation record](validation-2026-11-13.md) links the successful hosted runs and documents their measured results and limitations.

## Workflow arrangement

`deploy-heroku.yml` first runs the ordinary test workflow and deploys MCP → chat → admin → auth, checking health after each. Its `test-agent` job depends on `deploy-heroku` and calls the separate reusable `test-agent-live.yml` workflow. A failed deployment never starts the live agent tests. The existing deployment concurrency lock stays held through the post-deployment checks.

`test-agent-extended.yml` is manually dispatched on `main` and calls the same pytest workflow with the extended suite. It shares the deployment lock so another deployment cannot change the service midway through the tests. Neither live workflow runs for pull requests. Checkout uses the triggering/deployed commit, and credentials are not persisted in Git configuration.

The post-deploy job uses only the dedicated agent token, not Heroku, Cloudflare or human credentials. Its job targets the GitHub `testing` environment, whose `GH_ACTIONS_TCG_API_TOKEN` secret is mapped to the Python process’s `TCG_CI_API_TOKEN`. Named secret forwarding is used; unrelated secrets are not inherited. Missing/invalid secrets fail the job rather than silently skipping tests.

Provider reference: [GitHub reusable workflows and environment secrets](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

## Dedicated principal and policy

Create a separate API principal in the admin portal with a standalone role. Enable GPT 6 luna globally and allow `model:gpt-6-luna` for the role. A daily limit of 2,000,000 input + output tokens is a reasonable starting allowance for routine smoke runs and an extended suite; adjust from observed usage and deployment frequency. Quotas reset at midnight Japan time. Do not use a human administrator credential.

Example inline policy:

```json
{
  "statements": [
    {
      "effect": "Allow",
      "actions": [
        "agent:models:list", "agent:usage:read",
        "agent:conversations:read", "agent:conversations:write",
        "agent:executions:create", "agent:executions:read", "agent:executions:resume",
        "agent:preferences:read", "agent:preferences:write"
      ],
      "resources": ["*"]
    },
    {
      "effect": "Allow",
      "actions": ["agent:models:invoke"],
      "resources": ["model:gpt-6-luna"]
    }
  ]
}
```

API credentials always have an agent-only ceiling regardless of inherited permissions. Rotate the principal’s credentials before expiry; its usage and execution ownership persist across rotations. Store the token in the `testing` environment secret `GH_ACTIONS_TCG_API_TOKEN`. For local execution, use an ignored private token file or the process environment. Never put it in prompts, command-line arguments, URLs, source files or artifacts.

## Scenarios and correctness

The smoke suite asks for an exact two-card basket and an explicit printing clarification. The extended suite adds sourced Mega Gardevoir ex and Mega Charizard X ex decks, plus a Gardevoir collection with a 150,000 JPY product budget and a preference for full-art/illustration cards, including non-secret variants.

Tests assert structured outcomes instead of exact wording:

- Exact requested printings and quantities remain unchanged.
- Decks contain 60 cards, respect the four-copy limit (except basic Energy), include the requested attacker and pause for approval before pricing. The approved card list must match the final budget.
- Clarification includes selectable answers and does not price an unresolved printing. That test cancels the question explicitly.
- Prices come from both suppliers, have positive values and retain HTTPS sources and retrieval dates. Reference-estimate sums and JPY FX arithmetic are checked.
- Coverage is explicit. References cannot claim confirmed seller stock or a final purchase total; unknown shipping is not zero. Failed/disabled/empty retrieval must not manufacture a stock-shortage question.
- A collection is not a tournament deck. Its selected distinct printings must match the theme, reflect the catalog art preference and fit the product-subtotal ceiling. The spending calculation uses actual price references and verified FX, with exclusions and unknowns retained.

Fixtures are sequential because tokens for one principal share a quota/admission counter. Suite startup verifies the API principal, allowed model, quota and settled usage. It snapshots the principal’s preferences, temporarily selects JPY and a Tokyo shopping guide, then restores the original values even on failure. It never changes human settings or IAM policies.

Each scenario has a deadline and bounded follow-up decisions. Executions and resumes are not retried automatically: restarting them can duplicate provider charges. The suite checks a token-spend ceiling before starting each new scenario (150,000 for smoke; 1,000,000 for extended). These are admission limits, not exact provider-call caps; an admitted response can finish beyond them. A model error, incomplete SSE turn, unresolved unexpected question or exhausted quota fails the test honestly. A failed case that leaves a completed clarification turn is cancelled through the normal API, without approving or resuming research.

Reports include execution/conversation IDs, public source evidence, supplier outcome categories and completed reasoning summaries/tool metadata. HTTP headers and credentials are never serialized. Artifacts are redacted and retained for seven days in GitHub. Test conversations stay under the dedicated principal, labeled by CI run and scenario, so failures remain inspectable through the admin activity view. Deployment is not automatically rolled back if the post-deploy agent test fails: inspect the evidence and decide whether a code fix, source outage or configuration change is needed.

## Running locally

Ordinary `pytest` marks live scenarios skipped unless `TCG_LIVE_TESTS=1`. It does not load root `.env` automatically. Once explicitly enabled, missing credentials are an error.

```bash
# Supply TCG_CI_API_TOKEN privately in the process environment, or point to a
# mode-0600 file through TCG_TEST_TOKEN_FILE. Do not paste it into this command.
TCG_LIVE_TESTS=1 TCG_LIVE_SUITE=smoke \
  .venv/bin/python -m pytest tests/live --confcutdir=tests/live -q --tb=short

TCG_LIVE_TESTS=1 TCG_LIVE_SUITE=extended TCG_TEST_MAX_TOKENS=1000000 \
  .venv/bin/python -m pytest tests/live --confcutdir=tests/live -q --tb=short
```

The test client defaults to the hosted APIs. For explicit local testing, set `TCG_TEST_CHAT_URL=http://localhost:8080/api/chat` and `TCG_TEST_AUTH_URL=http://localhost:8080/api/auth`. Credentials are accepted only for the known production endpoints or explicit loopback port 8080. The live suite uses `--confcutdir` so it needs only pytest, pytest-asyncio and httpx, not the application’s database/provider dependencies.

## Collection graph behavior

`router → collection_builder → validate identities → card_search → collection_budget → quote → missing/decide → finish`

The builder researches a bounded candidate pool and records the requested subject, budget, currency, optional printing-count cap and number of copies. The default is one per printing. It does not require a 60-card deck or current tournament eligibility. After baseline prices arrive, deterministic selection prefers catalog full-art/illustration rarity categories when requested, then price, and never selects an item whose converted cost exceeds the remaining product allowance. It may leave budget unused. This is a curated candidate-pool proposal, not an exhaustive catalogue or an optimization claim.

The result shows the budget, selected subtotal, remaining allowance, original supplier prices, dated FX and excluded candidates. Unknown prices or conversion rates are excluded rather than treated as free. Catalog rarity is a preference proxy; inspect card images before purchase. Stock, language, condition, delivery, taxes and fees still require confirmation. Supplier-specific totals may differ from the mixed-source collection estimate and are shown separately.

Planning defers marketplace URL/price searches to the supplier stage, preventing repeated commercial-page research before a card or deck is resolved. The MCP wrapper forces ordinary HTTPX retrieval; it does not retry blocked pages with browser/TLS impersonation. Search challenges, HTTP failures, timeouts and genuine empty results remain distinct diagnostic outcomes.
