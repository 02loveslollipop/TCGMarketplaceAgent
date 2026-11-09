# Workspace UX

The workspace uses Cloudscape components and existing API contracts. This change affects presentation and interaction feedback; account permissions, authentication policy, model verification, streaming and budget calculations remain server-controlled.

## Pattern choices

- [Top navigation](https://cloudscape.design/patterns/general/service-navigation/top-navigation/): product identity, portal switching and account utilities. Side navigation separates the deck workspace, administration and account security. Hash locations support browser back/forward navigation.
- [In-context actions](https://cloudscape.design/patterns/general/actions/incontext-actions/): a model row opens its own named editor. The selected registry identifier stays visible; a successful save names the model and its availability. Closing returns keyboard focus to the triggering action.
- [Create](https://cloudscape.design/patterns/resource-management/create/) and [defaults](https://cloudscape.design/patterns/resource-management/create/defaults/): account/model creation has a dedicated dialog. New model policies visibly start disabled, ordinary-user access is the account default, and optional presets populate visible fields. Existing identifiers lead users to edit the existing policy.
- [Validation](https://cloudscape.design/patterns/general/errors/validation/): submission stays available so missing/invalid values can be explained beside their fields. Recoverable server errors stay in the editor with the draft intact. Canceling a changed form asks whether to discard it.
- [Table view](https://cloudscape.design/patterns/resource-management/view/table-view/): administration uses counted, searchable, paginated collections with row actions, availability indicators, loading and empty states.
- [Static dashboard](https://cloudscape.design/patterns/general/service-dashboard/static-dashboard/): administration opens with account/model counts and links to the corresponding collections. These are counts of loaded data, not service-health claims.
- [Details with tabs](https://cloudscape.design/patterns/resource-management/details/details-page-with-tabs/): recommendations and warnings precede budget, deck, offers and sources tabs. Unverified legality, missing quotations and unknown shipping remain explicit. Currencies and product subtotals are not combined into an invented final total.
- [Card view](https://cloudscape.design/patterns/resource-management/view/card-view/): visual deck inspection and a compact table are alternative views of the same requested printings, with search and pagination. Variant preferences and quantities are retained.
- [Delete confirmation](https://cloudscape.design/patterns/resource-management/delete/): the existing authenticator removal action names the key, explains the sign-out consequence, and requires confirmation before sending DELETE.

The attribute-editing and hub patterns were also reviewed. A model is one policy with fixed fields, so a focused editor is used rather than a dynamic attribute-row editor. The result summary and tabs provide the relevant details without introducing additional resource operations.

## Model-selection feedback

Chat keeps model choice next to conversation selection and announces changes in a polite live region. The composer also names the model for the next request. Both selectors are locked during execution/history loading. A waiting execution keeps its original model; the UI explains that a newly selected model applies to the next new request. Switching to account security preserves the mounted chat, its draft and its selected model.

## Sign-in and account recovery

The sign-in layout follows the [Cloudscape hero-header sign-in example](https://cloudscape.design/patterns/general/hero-header/#examples-of-hero-headers): a black high-contrast header stripe and a centered authentication card, with the original blue gradient and network backdrop filling the area below the stripe. Footer links use inverted colors for contrast against that backdrop. The footer provides “Back to sign in” during verification and “Back to verification” during recovery; restart buttons and the private-account caption are removed. The verification chooser contains enrolled TOTP/passkey methods only. A secondary link beneath the card opens the dedicated `#account-recovery` page, which replaces the verification form and explains the reset before requesting a code. The page supports return navigation, browser back/forward, and heading focus after navigation. Recovery codes are cleared when leaving the page. Opening its URL without an in-memory password challenge first requires password verification. The server's mandatory replacement-factor enrollment behavior is unchanged.

## Verification

Run `npm test` and `npm run build` from `frontend/`. Regression coverage includes exact model/request payloads, contextual save errors, cancel/discard behavior, focus restoration, validation, explicit enabled state, account payloads, model-change announcements, execution locking, security-page navigation, budget variants, SSE parsing, and existing authentication/onboarding flows.

Browser checks use private, ignored fixtures under `.runtime/ux-preview/` to exercise the actual React components without changing live account/model settings. Fixture prices, accounts, legality and quotations are synthetic. They do not establish supplier or live-device authentication results.

## Dashboard authenticators, roles, and appearance

Authenticator app and passkey creation use the [embedded sub-resource pattern](https://cloudscape.design/patterns/resource-management/create/sub-resource-create/). The account and enrolled credential list remain visible while setup fields are open. New passkeys require a name; TOTP setup keeps the QR/manual fallback and confirmation step. Canceling an entered setup asks before discarding it. Passkey setup receives keyboard focus and returns focus to its trigger when canceled. Successful enrollment retains the existing server-verified sign-in-again behavior.

Accounts have a named Change role action for the existing User and Administrator roles. The server revokes the changed account's sessions and prevents removal of the last active administrator, including concurrent demotions. A separate Role access and quotas page edits per-role model access and daily per-user quotas. Role-policy drafts survive dashboard navigation and require confirmation before cancellation. Role model access intersects global model enablement.

Appearance offers Light, Dark, and Dark blue on login and in top navigation, saved per browser origin. Cloudscape's visual mode API supplies Light/Dark; Dark blue is generated from themeable tokens using the [build-time theming API](https://cloudscape.design/foundation/visual-foundation/theming/). `npm run build` and `npm run dev` regenerate `src/dark-blue.css` from `scripts/generate-theme.mjs`. The login preserves its black header stripe and branded lower background in all three appearances.
