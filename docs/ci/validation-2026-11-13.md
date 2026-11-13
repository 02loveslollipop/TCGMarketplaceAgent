# Hosted agent validation — 13 November 2026

The backend release at `abbbd11` passed its [Heroku deployment and post-deployment smoke tests](https://github.com/02loveslollipop/TCGMarketplaceAgent/actions/runs/43365680032). The separate [extended pytest workflow](https://github.com/02loveslollipop/TCGMarketplaceAgent/actions/runs/43366532195) then passed all five scenarios against the hosted APIs using the dedicated CI API principal and GPT 6 luna. No database migration or account reset was required.

| Scenario | Verified result | Duration |
| --- | --- | --- |
| Exact basket | Four cards, two specified printings, both supplier guides, 12 price references; identities and quantities preserved. | 34.7 s |
| Printing clarification | Selectable printing question before pricing; cancelled through the API. | 35.9 s |
| Mega Gardevoir ex deck | 60 cards, 27 printings, explicit deck approval, verified legality, approved list preserved through the budget, 176 price references. | 154.3 s |
| Mega Charizard X ex deck | 60 cards, 24 printings, explicit deck approval, verified legality, approved list preserved through the budget, 167 price references. | 199.7 s |
| Gardevoir collection | 12 distinct printings, 54 price references; selected product estimate ¥92,225 within a ¥150,000 ceiling, leaving ¥57,775. | 97.4 s |

The complete Cardmarket guide estimates were ¥6,604 for Mega Gardevoir and ¥4,144 for Mega Charizard X. TCGplayer estimates were partial: ¥5,673 for 53/60 cards and ¥4,433 for 52/60, respectively. Partial totals must not be compared as complete deck costs. Original EUR/USD amounts, source links, retrieval dates and the applied exchange rates remain in the result artifacts.

These are indicative product costs. Live seller listing retrieval was disabled by configuration, so stock, condition, language, shipping, taxes and a confirmed purchase total remained unverified. No missing-stock decision was manufactured from that limitation. Collection art preference uses catalog rarity as a proxy and requires image inspection; selection covers the researched candidates rather than an exhaustive or optimal catalogue. Future runs can choose different sourced cards and return different prices.

The final extended suite consumed 430,742 provider-reported input + output tokens. Total CI-principal usage including this round's earlier debugging and smoke runs was 957,550 of its configured 3,000,000-token daily quota. Its original preferences were restored and no model call or unverified usage remained active afterward. Credentials and HTTP headers are excluded from reports. GitHub retains the redacted artifacts for seven days; the principal's conversations remain available for investigation.

The ordinary PostgreSQL-backed suite passed 238 tests, with two live scenarios skipped by default. The final frontend suite passed 85 tests and the production build. Both deck approval routing and the distinction between missing prices and unverified seller availability have regression coverage.

The first extended run exposed a model-authored approval question incorrectly entering generic clarification. The fix routes only a complete, validated list with explicit approval/revision choices into the application-owned review step; genuine format or printing questions remain intact. An earlier Charizard request also correctly triggered a rotation clarification, so the Standard deck scenario now uses catalog-verified Mega Charizard X ex. These failures were investigated and corrected before the successful run; they were not skipped or retried automatically.
