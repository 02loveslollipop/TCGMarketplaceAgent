---
name: tcgdex-graphql
description: >
  Query Pokémon TCG card metadata, sets, series, regulation marks, and legality
  directly from the TCGdex GraphQL API (`https://api.tcgdex.net/v2/graphql`) in
  both English (`en`) and Japanese (`ja`) without scraping marketplaces or deck
  lists. Covers GraphQL query syntax, `@locale` directives, `CardsFilters`,
  batched multi-card alias queries, and the agent's `query_tcgdex_graphql` tool.
---

# TCGdex GraphQL API Skill

Use this skill whenever querying Pokémon TCG cards, sets, series, regulation marks, or legality directly from TCGdex's free, unauthenticated GraphQL API (`https://api.tcgdex.net/v2/graphql`) or via the orchestrator's `query_tcgdex_graphql` tool.

## Endpoint & Authentication

- **Endpoint**: `POST https://api.tcgdex.net/v2/graphql`
- **Headers**: `Content-Type: application/json`, `Accept: application/json`
- **Authentication**: None required (generous free quota, supports multi-card and filtered batch queries in a single HTTP request).

## Locales (`@locale` Directive)

TCGdex GraphQL defaults to English (`en`) and supports switching language at the field level using `@locale(lang: "<code_or_locale>")`:

- **International / English**: `@locale(lang: "en")` (or omit `@locale`)
- **Japan / Japanese**: `@locale(lang: "ja")`

Example querying Japanese sets:
```graphql
query {
  sets @locale(lang: "ja") {
    id
    name
    releaseDate
    tcgOnline
    serie {
      id
      name
    }
    cardCount {
      total
      official
    }
  }
}
```

## Querying Cards with Filters (`cards`)

Use `cards(filters: CardsFilters, pagination: Pagination, sort: Sort)` to search cards with rich metadata in a single request—without hitting marketplace scrapers or decklists.

### Supported `CardsFilters` Fields
- `name`: `String` (substring match)
- `id`: `String` (e.g. `"me01-077"`, `"sv07-057"`)
- `localId`: `String` (card number inside set, e.g. `"077"` or `"77"`)
- `regulationMark`: `String` (e.g. `"H"`, `"I"`, `"J"`, `"G"`, `"F"`)
- `category`: `String` (`"Pokemon"`, `"Trainer"`, `"Energy"`)
- `stage`: `String` (`"Basic"`, `"Stage1"`, `"Stage2"`, `"MEGA"`, `"V"`, `"VMAX"`, `"VSTAR"`, `"ex"`)
- `trainerType`: `String` (`"Supporter"`, `"Item"`, `"Tool"`, `"Stadium"`)
- `energyType`: `String` (`"Normal"`, `"Special"`)
- `rarity`: `String`
- `hp`: `Int`

### Standard Card Selection Set
```graphql
query SearchCards($filters: CardsFilters, $pagination: Pagination) {
  cards(filters: $filters, pagination: $pagination) @locale(lang: "en") {
    id
    localId
    name
    image
    category
    hp
    stage
    trainerType
    energyType
    regulationMark
    rarity
    legal {
      standard
      expanded
    }
    set {
      id
      name
      releaseDate
      tcgOnline
    }
  }
}
```

## Batching Multiple Cards by ID in One Request (GraphQL Aliases)

Instead of issuing 60 separate REST requests for a 60-card deck, fetch up to 60 cards in **1 HTTP request** using GraphQL field aliases:

```graphql
query BatchCards {
  c0: card(id: "me01-077") @locale(lang: "en") {
    ...CardFields
  }
  c1: card(id: "sv07-057") @locale(lang: "en") {
    ...CardFields
  }
}

fragment CardFields on Card {
  id
  localId
  name
  image
  category
  hp
  stage
  trainerType
  energyType
  regulationMark
  rarity
  legal {
    standard
    expanded
  }
  set {
    id
    name
    releaseDate
    tcgOnline
  }
}
```

## Important TCGdex GraphQL Schema Rules & Pitfalls

1. **Never query `set { serie { id name } }` nested inside `Card`**:
   - On TCGdex's GraphQL server, resolving `Set.serie` from a nested `Card.set` throws `"Cannot return null for non-nullable field Set.serie"`.
   - Always query `set { id name releaseDate tcgOnline }` on `Card`, and query `serie { id name }` only on top-level `sets` or `set(id: ...)`.
2. **Never pass `pagination` to top-level `sets`**:
   - Passing `pagination` to `sets(pagination: ...)` triggers an upstream TCGdex bug (`value.indexOf is not a function`). Query `sets` without `pagination` (it returns all ~200 sets cleanly in one call).
3. **Zero-Padded `localId` Normalization**:
   - Modern Scarlet & Violet (`sv*`) and Mega Evolution (`me*`) sets store 3-digit zero-padded `localId` values (`"057"`, `"077"`), whereas older sets (`xy3-54`, `bw3-67`) use unpadded numbers (`"54"`, `"67"`).
   - When resolving a `set_code` + `number` pair, try both the raw number and `number.zfill(3)` (or `lstrip("0")`) in your GraphQL alias batch so neither format fails.
4. **Legality Nuances**:
   - `Card.legal { standard expanded }` is accurate for International Standard (`regulationMark` in `H`, `I`, `J`), International Expanded (`bw`, `xy`, `sm`, `swsh`, `sv`, `me`), and Japan Standard (`H`, `I`, `J`).
   - However, TCGdex's upstream `meta/legals.ts` returns `legal.expanded: false` for `/v2/ja` cards because it checks lowercase English series IDs (`bw`..`me`) rather than Japanese series IDs (`BW`, `XY`, `SM`, `S`, `SV`, `M`), and omits recent bans (`Duskull swsh11-060`, `Flapple swsh2-22`).
   - Always combine TCGdex card metadata with the PostgreSQL legality catalog (`query_legality` tool) for authoritative International & Japan Standard/Expanded legality and banned-card checks.

## Agent Tool Integration (`query_tcgdex_graphql`)

Inside the LangGraph orchestrator (`services/orchestrator/research.py`), the agent has direct access to:
- `query_tcgdex_graphql(...)`: Queries `https://api.tcgdex.net/v2/graphql` with structured filters (`name`, `set_id`, `local_id`, `regulation_mark`, `category`, `stage`, `trainer_type`, `energy_type`, `rarity`, `language`, `limit`), caches discovered cards in `research.cards`, and records verifiable sources.
- `search_cards(name, language="en")` and `get_cards(card_ids)`: Powered by TCGdex GraphQL to return full set, regulation mark, and legality metadata in a single request.
