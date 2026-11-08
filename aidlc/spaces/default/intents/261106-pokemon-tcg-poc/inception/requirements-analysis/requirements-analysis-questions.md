# Requirements Analysis Questions

## Q1. How should deck generation handle the format and an incomplete request?

- A. Ask for the format and missing essential preferences before generating a deck.
- B. Propose a format and clearly ask the user to confirm it.
- C. Let the agent choose and clearly state its assumptions.
- X. Other (please specify).

[Answer]: X. Proceed autonomously when the card and deck request can be resolved; ask when material details such as printing or format are ambiguous. Provide agents with current standard-set and ban-list knowledge to avoid format errors. Example: "Make a M Lucario ex (Mega evolutions set) with Toucannon for standard format" versus ambiguous "Make a M Gardevoir EX deck".

## Q2. How should the agent handle a missing card or an incomplete budget?

- A. Show missing items, explain the limitation, and ask before substituting; never call an incomplete budget complete.
- B. Automatically choose an explicitly labelled substitute and show the incomplete original budget.
- C. Stop and request clarification whenever a card is missing.
- X. Other (please specify).

[Answer]: X. Ask for substitutes, providing guidance on good alternatives; if none can be found or used, allow a card to remain missing only with explicit user permission.

## Q3. How should card conditions, printings, languages and currencies affect comparisons?

- A. Ask the user when material preferences are missing; compare only matching approved variants, and keep different currencies separate unless a sourced conversion is available.
- B. Offer clearly labelled alternatives and ask the user to choose when differences affect comparability.
- C. Define another rule.
- X. Other (please specify).

[Answer]: A. Ask the user when material preferences are missing; compare only matching approved variants, and keep different currencies separate unless a sourced conversion is available.

## Q4. How should account creation and administrator access work for the two-person PoC?

- A. An initial administrator creates accounts; no public self-registration.
- B. Allow self-registration and assign administrators separately.
- C. Define another process.
- X. Other (please specify).

[Answer]: A. An initial administrator creates accounts; no public self-registration.

## Q5. What should the app do when the selected Apify Actors are unavailable or exceed available credits?

- A. Report the limitation and offer a reference catalog or manual import, clearly labelled, until live sources are available.
- B. Report the limitation and stop the affected price retrieval.
- C. Define another permitted fallback.
- X. Other (please specify).

[Answer]: X. We will not handle this during this PoC.

## Consolidated Summary Confirmation

- Proceed autonomously when the card and deck request can be resolved; ask when material details such as printing or format are ambiguous. Provide agents with current standard-set and ban-list knowledge.
- Ask about substitutes and provide guidance on alternatives; leave a card missing only with explicit user permission when a substitute cannot be found or used.
- Ask when material card preferences are missing; compare only matching approved variants and keep currencies separate unless a sourced conversion is available.
- An initial administrator creates accounts; no public self-registration.
- Handling unavailable Actor access or exhausted credits is outside this PoC. Supplier retrieval remains logged-out, read-only public listing access.

Does this all look correct before I generate the requirements artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
