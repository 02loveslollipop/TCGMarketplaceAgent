# Project review — 2026-11-12

Reviewed checkout: `main`, baseline commit `19db67e`. This report records the review before the deck-approval and currency
feature work. Corrections are included in the subsequent release commits. The pre-existing AI-DLC audit edit was preserved.

## Current implementation

Two React/Cloudscape portals share an authenticated administrator session through
the auth service. The Python services are auth, admin API, agent orchestration,
and authenticated DuckDuckGo MCP search/fetch. PostgreSQL stores application data
in `pokemon_tcg_poc`, including conversations, execution checkpoints, token usage,
preferences, and legality snapshots. Deployment definitions target Cloudflare
Pages for the portals and Heroku buildpacks for the four backend services.

The old HANDOFF.md describes the November 9 state and predates these features.

## Corrected defects

| Priority | Defect | Correction |
| --- | --- | --- |
| P1 | TCGdex aggregate prices became in-stock listings, with quantities invented from the requested quantity and condition/language copied from the request. | Keep them as reference prices with unknown stock and variant guarantees. They cannot satisfy purchase coverage or produce confirmed budgets. Do not infer a foil price from the requested finish. |
| P1 | Legality refresh requested an unsupported GraphQL `Set.abbreviation` field; GraphQL errors could become an empty successful catalog or silent seed fallback. | Use the live supported schema, reject partial/error responses, and resolve the legacy `sm35-45` banned-card identifier to verified `sm3.5-45` metadata. |
| P1 | Failed refreshes could replace real data with static defaults while reporting a successful fresh sync. | Retain the previous snapshot and its retrieval date, report failure, retry after an hour, and make the refresh CLI exit unsuccessfully. |
| P1 | Empty/stale/failed catalogs and a failed model validation could produce verified legality. Source lists also included official pages that were never fetched. | Require fresh catalog evidence for deterministic verification, preserve uncertainty on failure, and return only recorded source evidence. |
| P1 | Session restoration tried the cookie before an explicit bearer token, potentially restoring another signed-in account. Invalid bearer tokens could fall back to that cookie. | Explicit credentials determine the account and fail independently of cookies. |
| P2 | The absolute session cap applied to refresh admission but not ordinary access or renewed token expiry. | Enforce it on ordinary token reads and clamp token/cookie expiration to the original session deadline. |
| P2 | Updating a session token ran chat effect cleanup, aborting an active stream and resetting model selection. | Abort streams only on unmount; preserve the selected model when still enabled. |
| P2 | Auto ruleset validation could ask the same International/Japan question after an explicit answer. | Reuse the user's answer to the ruleset question within that conversation. |
| P2 | Card normalization could replace a missing printing with a same-name, same-number card from another set. Partial GraphQL responses could also discard full cached metadata. | Require a matching set for fallback identity resolution and preserve previously fetched metadata. Ignore nested set/series objects in the card cache. |

The price-feed distinction follows the fields exposed by the
[TCGdex card reference](https://tcgdex.dev/de/reference/card): aggregate prices do
not establish seller inventory, condition, language, or quantity.

## Remaining findings

- **P1 — Printing/effect-specific bans:** planner ban matching still treats a
  matching card name as banned even when a record identifies a specific printing.
  This can over-block other cards with the same name. The Japanese importer also
  keeps ability/set restrictions inside display text instead of structured rules.
  Resolve these restrictions before treating the catalog as a tournament legality
  authority.
- **P2 — Reprints and effective dates:** Standard validation rejects missing or
  old regulation marks without resolving legal reprint exceptions. Set eligibility
  uses broad series/date heuristics; it does not model individual tournament
  effective dates. Japan's active marks and supplemental international bans remain
  partly maintained in code.
- **P2 — Refresh scheduling:** the weekly refresh is checked when the agent needs
  legality knowledge. There is no independent weekly scheduled job while the app
  remains unused.
- **P3 — Frontend weight:** production build succeeds but warns about the shared
  JavaScript chunk (about 1.36 MB before compression). Lazy loading portal/admin
  surfaces is a useful next performance change.

## Verification and limits

- Backend suite: **164 passed, 1 skipped**. The skipped PostgreSQL concurrency test
  was then run separately against a disposable local PostgreSQL 16 container:
  **1 passed**. That container was removed afterward.
- Frontend: **69 passed**; TypeScript and Vite production build succeeded.
- `docker compose config --quiet` and `git diff --check` succeeded.
- Read-only live legality dataset construction succeeded with **423 set records
  and 71 ban records**. Nothing was persisted to the application's database.
- Added 17 backend regression cases and one frontend regression test. Existing
  pricing tests now assert reference-only behavior instead of fabricated stock.
- No deployment, production database mutation, paid model/supplier invocation,
  or new physical-authenticator/browser acceptance test was performed.
