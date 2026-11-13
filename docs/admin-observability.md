# Administration consumption and execution observability

The overview follows Cloudscape's [static dashboard pattern](https://cloudscape.design/patterns/general/service-dashboard/static-dashboard/): important metrics first, contextual charts next, and resource configuration afterward. Consumption adds principal, historical-role and model drill-downs, custom dates, current quota meters and model pricing configuration. Built-in Cloudscape charts, tables and collection hooks provide chart interactions, sorting, filtering and pagination without adding Highcharts.

Activity provides session/model controls, a bounded transcript, chronological public reasoning summaries and tool calls, a timestamped event timeline, application log details and a side panel of execution context. The trace uses Cloudscape [thinking](https://cloudscape.design/gen-ai/patterns/thinking/) and [timeline](https://cloudscape.design/gen-ai/patterns/timeline-overview/) components. The composer stays outside the transcript scroll region. Another principal's execution is read-only; a new test session uses the administrator's own identity, permissions and quota.

## Metrics

- Input and output tokens come from provider-reported usage through the existing guarded model invocation. Analytics do not start model calls.
- Historical roles use the role ID and recorded name at call admission. Role changes do not move older consumption. Inheritance does not create a pooled role allowance.
- Current quota meters show today's principal total and its present effective role allowance, including inherited limits and child overrides. These are separate from the selected report period. Quotas reset at midnight Asia/Tokyo; admitted responses may exceed the remaining allowance.
- Estimated USD cost covers only priced usage. Unpriced tokens remain visible and are not treated as free usage. This standard input/output estimate excludes cache adjustments, provider discounts unless reflected in configured rates, taxes and external tool fees. It is not a provider invoice.
- Model call time sums recorded provider-call wall times. It does not measure end-to-end execution latency or time waiting for a human decision.

Calls retain the Japan-time quota date at admission, including responses finishing after midnight. Rejected and unverified calls have separate counters. Unknown provider usage is not reported as a successful zero-cost call. Unsettled or unverified admissions can block further calls until usage settles or the quota resets.

## Earlier data and coverage

Older versions kept daily principal totals without per-call roles, model identity or pricing. Those tokens remain in totals under **Historical role not recorded** and the **unattributed** model group, with no fabricated historical cost. Current names and allowances can be enriched from authentication when the viewer has the corresponding account/principal read permissions; enrichment never changes historical attribution.

Reports support up to 90 inclusive Japan-time dates. At most 100,000 call-detail records are loaded per report. Reaching that bound is explicitly marked, and unmatched daily-counter usage remains unattributed. Activity loads the latest 200 executions with a labelled bound; its API allows up to 500. Messages are scoped to the selected execution, and repeated thinking/tool updates are coalesced by span ID. Structured log views are bounded and redact credential and private-reasoning fields.

## Pricing references

Standard text rates checked on **13 November 2026** apply to exact provider API identifiers:

| API identifier | Input USD / million | Output USD / million | Source |
| --- | ---: | ---: | --- |
| `gpt-6-luna` | 0.10 | 0.50 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| `gpt-6.1-terra` | 1.00 | 5.00 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.1-terra) |

Mistral Medium and unrecognized identifiers remain unpriced until an administrator configures an appropriate rate. A `latest` alias is not substituted with another model's pricing. The editor accepts a public HTTPS reference or a rate description. Explicit zero rates represent a free contract; leaving both rates unset disables estimates.

Currency, rates and reference are snapshotted at admission. Pricing edits affect future calls only. Provider/API-identifier changes invalidate a custom rate tied to the former identity. Calculation uses Decimal arithmetic and eight decimal places in USD; chart numbers are display values rather than billing arithmetic.

## Storage and access

No schema migration or new database grants are required. The existing app-owned `logs` table stores append-only `model_call_started`, `model_usage` and `model_pricing_changed` records. Completion updates the ledger and the existing `daily_token_usage` counters in one transaction. Duplicate completion cannot charge either twice. New records contain no prompts, credentials or raw private reasoning.

Existing service grants cover these operations, entirely within `pokemon_tcg_poc`. The admin service proxies reports through the orchestrator and gains no direct usage-counter-table access. Authentication remains authoritative for current account metadata.

- `admin:usage:read` permits reporting and its navigation entry.
- `admin:models:read` permits reading pricing references.
- `admin:models:write` on `model:<registry-id>` permits rate changes.
- Existing activity and legality permissions continue to gate those views.
- API credentials retain their agent-only ceiling, including when assigned a broad inherited policy.

Endpoints: `GET /api/admin/consumption`, `GET /api/admin/model-pricing`, `PUT /api/admin/model-pricing/{model_id}` and existing activity routes. Report filters: `start`, `end`, `principal_id`, `role_id`, `model_id`. Execution responses add optional usage metadata. Older clients retain their contracts; application rollback does not remove ledger history or change daily quota semantics.

## Validation and release

Tests cover immutable role/rate snapshots, historical residuals, midnight attribution, duplicate completion, missing usage, model identity changes, permissions, current quota enrichment, PostgreSQL JSON queries, UI drill-downs, pricing forms and execution ownership. Browser checks cover desktop/mobile layouts and Light, Dark and Dark blue themes. Preview screenshots are labelled synthetic data; the application reads persisted backend data.

This iteration is local. For release, deploy the additive backend before the frontend so reports exist when navigation appears. Deployment and post-deployment smoke workflows remain unchanged.
