# Supplier research

Research date: 2026-11-06. Candidates are not yet validated for actual catalog coverage, credentials, listing availability, or full-deck completion.

| Candidate | Evidence and access | PoC qualification |
|---|---|---|
| CardFlow | [Public developer documentation](https://www.cardflowmarket.com/developers) describes a keyless read-only Pokémon catalog and listings API, with condition and seller photos. | Strong candidate; check listing depth, purchase URLs and quantity in practice. |
| eBay | [Browse API](https://www.developer.ebay.com/develop/api/buy/browse_api) searches listings with application credentials. | Not selected: sandbox data is not live offers. |
| TCG Plein | [API documentation](https://tcgplein.nl/api/docs) describes a Pokémon catalog and seller keys; [card documentation](https://tcgplein.nl/index.php/api/docs/cards) describes public listings and marketplace links. | Candidate contingent on testing inventory coverage with scoped credentials. |
| CardTrader | Market APIs provide availability and pricing. | Not evaluated for this PoC. |

The PoC does not depend on the TCGplayer or Cardmarket developer APIs; it retrieves logged-out public listing data through Apify Actors.

Catalog or price aggregation services can supplement card metadata, but market reference prices alone are not available purchase offers and do not establish stock, an exact listing, or a second independent supplier.

## No-wait and Playwright investigation

- CardFlow's documented keyless listings API returned HTTP 200 on 2026-11-06, with 197 Pokémon listings at that moment. This is an inventory count, not a measure of complete-deck coverage; individual listing links and quantities still need checking.
- [Vollector](https://vollector.id/docs/public-api) documents a free keyless listing API with purchase links, but a live request returned an empty list on 2026-11-06. Its documented examples focus on graded/tokenized collectibles, so deck suitability is unproven.
- TCG Plein's robots.txt did not disallow public product paths when checked on 2026-11-06. robots.txt is treated as best practice, not as the legal basis for access. Seller API credentials and issuance timing are unverified.
- No additional Playwright supplier with sufficient playable-card inventory was established. The PoC uses a third-party Apify Actor for logged-out public listings rather than marketplace internal endpoints.
- [TCGdex](https://tcgdex.dev/faq) is a free keyless metadata source; [PokeMP](https://pokemp.com/api) provides keyless daily TCGplayer price observations. Neither is independently verified as a source of live purchasable offers.

## Apify Actor discovery

Apify MCP is available after the client restart. Store searches found [LigaPokemon](https://apify.com/gio21/ligapokemon-scraper), which advertises seller offers at $0.005 per run plus $0.006 per result; actual outputs have not been verified. [TCGplayer](https://apify.com/devcake/tcgplayer-data-scraper) and [Cardmarket](https://apify.com/phantom_coder/cardmarket-listings-scraper) Actors advertise listings and charge per event. No Actor had been run and no listing coverage was validated through Apify at research time.
