# Requirements

## Intent analysis

Demonstrate an autonomous Pokémon TCG purchasing and deck-building agent as a private PoC for broader applications: it interprets requests, researches cards and decks, compares sourced offers, follows up on gaps, and explains budgets. Source: [intent statement](../../ideation/intent-capture/intent-statement.md); original requirements: [AGENTS.md](../../../../../../AGENTS.md); confirmed answers: [questions](requirements-analysis-questions.md).

## Functional requirements

- **FR1 — Requests and dialogue:** Accept natural-language card and deck requests in a web chat, extract quantities and preferences, and maintain a conversation. Ask about material ambiguity, including card identity and format; continue autonomously when the request is sufficiently resolved. Verify with clear and ambiguous request scenarios.
- **FR2 — Research and legality:** Use a free web search tool other than OpenAI web search to find deck information as needed. Provide current, sourced Standard legality and banned-card knowledge to the agent; identify when it cannot verify legality. Verify against dated sources and an ambiguous printing.
- **FR3 — Supplier tools:** Provide prebuilt tools for prices from at least two suppliers, with TCGplayer and Cardmarket Apify Actors selected. Preserve name, printing, condition, quantity or packaging, price, currency, supplier, source URL or identifier, retrieval time and availability, marking unknown fields. Verify that each returned offer retains provenance.
- **FR4 — Comparison:** Match card identity, printing, condition and language against approved preferences; distinguish equivalent cards, substitutes and insufficient data. Ask when material preferences are missing. Keep currencies separate unless a sourced conversion is available. Select lowest comparable price for the PoC. Verify variant mismatches and multi-currency cases.
- **FR5 — Missing cards:** Present missing cards and recommend possible substitutes with guidance; ask before substitution. Retain missing items only after explicit user permission. Verify both substitution and missing-item flows.
- **FR6 — Budgets:** Show requested cards and offers, supplier budgets where coverage is sufficient, and a feasible combined option. Show quantities, product subtotals, known extra costs, missing quotes, unverified conditions, recommendation and source links. Do not treat unknown shipping as zero or claim a confirmed final total when costs are unknown. Verify complete, partial and unknown-shipping cases.
- **FR7 — Rich streaming UI:** Provide a React Cloudscape chatbot with predefined rich card components including images, card codes, prices and links; stream agent responses and progress steps over WebSockets or HTTPS SSE. Verify streamed updates and rich card rendering.
- **FR8 — Models:** Let users select an enabled OpenAI GPT-family model from GPT 6 luna or GPT 6.1 terra and Mistral `mistral-medium-latest`; administrators control the allowed models. Verify that disallowed models cannot be selected or invoked.
- **FR9 — Accounts and authentication:** An initial administrator creates accounts; no public self-registration. Use JWT and OAuth2, Argon2id password hashes, and support authenticator-app and FIDO2 security-key 2FA. Physical-key implementation and testing comes last with the requester participating. Verify access control and each supported authentication flow.
- **FR10 — Persistence:** Store credentials, chat history, executions and logs in PostgreSQL. Create a dedicated schema and application role with only the permissions needed for the application; the admin URI is for provisioning, not app runtime. Do not read or use other schemas. Verify role grants and persistence.

## Non-functional requirements

- **NFR1 — Security:** Keep API tokens and database credentials out of client code and logs; protect passwords with Argon2id and enforce authentication and administrative authorization server-side. Verify through configuration and authorization tests.
- **NFR2 — Provenance:** Distinguish verified offers, reference prices, unknown availability and incomplete results. Preserve retrieval timestamps and source identifiers for each offer; do not represent a market reference as a purchasable listing. Verify against returned data.
- **NFR3 — Observability:** Persist execution steps and logs without secrets and show progress as execution occurs. Verify an example execution and redaction.
- **NFR4 — Accessibility and design:** Use Cloudscape design system components for the React UI. Verify component use and core keyboard interactions.

## Construction clarifications to FR9

These refinements were requested after the original Requirements Analysis approval and are recorded separately from that approval:

- **FR9a — First-login enrollment:** A newly created account must confirm an authenticator app or passkey/security key before accessing chat or administration. Enforce the restriction at the APIs as well as the UI; unconfirmed enrollment must not grant normal access. Source: requester messages ae21a75f and 3082879a.
- **FR9b — Recovery codes:** Provide single-use recovery codes that replace the second factor after the correct password. Show plaintext codes once and persist only hashes; used codes cannot be replayed. Source: requester messages ae21a75f and b57e1dbc.
- **FR9c — Multiple authenticators:** Allow multiple named passkeys/security keys on one account and verify that adding another preserves existing credentials. Source: requester message ae21a75f. Existing multiple-credential support should be retained.

## Constraints

- Private PoC; no public product deployment is requested. [Intent statement](../../ideation/intent-capture/intent-statement.md)
- Use LangGraph and LangChain orchestration, React, PostgreSQL, and streaming over WebSockets or HTTPS SSE. Source: original requirements in AGENTS.md.
- Use free web search, not OpenAI's web search tool. Supplier retrieval is logged-out and read-only: do not bypass a login, paywall, CAPTCHA or other technical block, and collect only public listing data with minimal personal data. Source: AGENTS.md and the project's academic PoC scope.
- Geography is not considered for this PoC; do not infer shipping is free. Source: intent statement.
- Never use the shared database admin account for application connections or read other projects' schemas. Source: AGENTS.md.

## Assumptions

- Supplier prices come from logged-out, publicly accessible marketplace listings retrieved through the selected Apify Actors. Retrieval is read-only, does not circumvent technical blocks and stores no personal data beyond public seller display names.

## Out of scope

- A special fallback for unavailable Actor access or exhausted credits is not part of this PoC. Source: Q5.
- Geography-based selection and public self-registration are excluded. Source: intent statement and Q4.

## Open questions

- Determine how to obtain and refresh authoritative format-legality data, and how stale or unavailable data is presented.
- Establish account bootstrap, OAuth2 flow, model availability, deployment environment, currencies and security-key test details during implementation planning without assuming the answers.
