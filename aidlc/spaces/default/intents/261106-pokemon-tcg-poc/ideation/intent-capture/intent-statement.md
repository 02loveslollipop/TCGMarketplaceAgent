# Intent Statement

## Problem Statement

Explore whether an AI agent can autonomously search for Pokémon TCG cards, compare offers, make decisions and follow up when a card does not exist or is unavailable from providers. The PoC is intended to demonstrate capabilities applicable to other real use cases. [Q1] [Q3]

## Target Customer

The work involves the requester and another person; there is no defined business client or end user of the app. [Q2]

## Success Metrics

The agent can search for cards and display images and codes in the UI; a chat session can generate full decks with prices and links to buy the cards. [Q5]

## Initiative Trigger

Explore whether the proposed agent can reliably compare card offers and prepare budgets. [Q3]

## Initial Scope Signal

- Workflow-selected scope: `poc`. [scope]
- The first PoC retains all stated requirements, including authentication and both 2FA methods, with physical-key testing last, mostly for security reasons. [Q4]
- The source is the requirements supplied by the requester in AGENTS.md. These include at least two suppliers, verifiable budgets, a React Cloudscape chat interface, model selection and administration, and database isolation. [Q4] [Q7]
- Geography is not considered. The PoC selects by lowest price; configurable selection could be considered in future. [Q7]
- The selected supplier candidates are TCGplayer and Cardmarket using Apify Actors for logged-out, read-only public listing retrieval. [Q8]

## Assumptions & Open Questions

- Supplier retrieval reads publicly accessible listings without logging in or bypassing any technical block, and stores no personal data beyond public seller display names. [assumption]
