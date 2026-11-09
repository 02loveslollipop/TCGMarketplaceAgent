# Chat experience

The chat workspace follows Cloudscape’s GenAI foundation and patterns. The documentation set supplied for this redesign was reviewed before implementation, including all nine explicitly required pages. Implementation uses the APIs of the installed Cloudscape components.

## Layout and interaction

The full-page structure follows the [official Cloudscape chat demo](https://cloudscape.design/examples/react/chat.html) and its [React source](https://github.com/cloudscape-design/demos/tree/main/src/pages/chat). A single AppLayoutToolbar owns the application navigation and chat surface. Chat is direct layout content, without ContentLayout, a surrounding container, a second navigation rail or a redundant page header.

The service top bar retains account utilities, appearance and portal switching. The application’s navigation rail contains a counted, searchable Conversations list. There is no event log or separate timeline. Execution activity remains in its expandable transcript sections. Cloudscape collapses this navigation on small screens; choosing a conversation closes the mobile navigation. The landing view centers its heading, composer and editable support prompts in the available main area. Once started, the transcript fills that area and the composer stays below it.

Only the message log scrolls during normal conversation. The composer stays reachable, with the model selector, remaining daily allowance and quotation guidance beside it. An explicit Jump to latest action appears when updates arrive while the user is reading older content. New turns initiated by the user return to the latest message.

An empty conversation offers three editable starter prompts. Selecting one inserts a draft and focuses the input; it never starts a provider call. Placeholder variables remain ordinary editable text. Outgoing and incoming messages have distinct alignment and avatars. Copy and edit/reuse actions remain visible.

Real workflow events appear in an expandable activity trace. Active work has a loading avatar and loading bar; completed traces collapse. Stopped and failed work retain their actual outcome. Progress events do not provide a reliable total, so the interface does not fabricate percentages, durations or completion counts.

Deck and budget artifacts appear as selectable action cards, stacked outside response bubbles. They retain printing/card counts, legality status, missing quotations and unconfirmed shipping. Opening a card displays the full existing card, budget, offer and source components in a resizable Cloudscape SplitPanel. Cloudscape adapts it to a bottom panel on smaller screens. Standalone Chat consumers use a modal preview. Source links, retrieval dates, currencies and unknown totals remain intact.

A clarification or missing-card decision is docked above the composer and stays keyboard accessible. Its heading receives focus. Missing-card variants and the scope of consent remain visible; explicit approval is required before researching substitutes or keeping cards missing. Only actions offered by the server appear. The chosen action is recorded in the transcript. Saved server decisions are restored as readable conversation messages.

## Required pattern mapping

| Documentation | Application |
| --- | --- |
| [Foundation](https://cloudscape.design/gen-ai/foundation/) | Cloudscape tokens, theme-aware surfaces, consistent typography and restrained GenAI emphasis. Colors, iconography and visual affordance were reviewed together. The official demo supplies the full-page layout structure. |
| [Patterns](https://cloudscape.design/gen-ai/patterns/) | The workspace separates input, ongoing work, generated responses and user decisions. |
| [Conversational history](https://cloudscape.design/gen-ai/patterns/conversational-history/) | Counted searchable list, meaningful saved titles, incremental View more, active selection and independent history-error retry. The list API has no creation dates, so recency grouping is omitted. Actual message timestamps are shown when returned by history. |
| [Generative AI chat](https://cloudscape.design/gen-ai/patterns/generative-ai-chat/) | Distinct avatars, constrained bubbles, pinned composer, editable starter prompts, persistent copy actions and live announcements. |
| [Response regeneration](https://cloudscape.design/gen-ai/patterns/response-regeneration/) | Stop remains immediate. Edit and reuse copies the original request into a draft. The existing API does not support context-preserving response replacement or branching, so re-prompting is not labeled Regenerate. |
| [Thinking](https://cloudscape.design/gen-ai/patterns/thinking/) | The API supplies execution events rather than an additional-reasoning summary. Those events use activity/progressive steps. No synthetic thinking trace or unsupported Skip thinking control is added. |
| [Timeline overview](https://cloudscape.design/gen-ai/patterns/timeline-overview/) | Reviewed; the separate timeline/event log was removed at the user’s request. The transcript retains the requests, decisions, results, failures and execution activity. |
| [User authorized actions](https://cloudscape.design/gen-ai/patterns/user-authorized-actions/) | Existing per-decision consent and cancellation are presented in context, and resolved decisions remain in the conversation. No permission scopes are offered without backend persistence. |
| [Artifact previews](https://cloudscape.design/gen-ai/patterns/artifact-previews/) | Selectable previews outside bubbles open detailed artifacts in an adjacent review surface. The artifact owns its review action; message actions belong to the message. |

## Feature coverage and remaining work

- Implemented: full-page chat, saved history, editable support prompts, model selection, real execution activity, loading/stop/error states, scoped approval, saved decision outcomes, and artifact review panels.
- Not implemented: provider-supplied reasoning summaries (the Thinking pattern). The backend currently invokes models without requesting, extracting or streaming reasoning summaries, and the frontend event contract has no thinking event. ActivityTrace displays execution progress only. Adding a Thinking section requires provider support plus backend event, persistence and UI integration.
- Not implemented: true response regeneration. Edit and reuse makes a new request; replaying the original context and replacing/branching its response requires backend support.
- Not implemented: feedback submission, attachments, persistent tool-authorization scopes, history rename/delete and recency groups. These require API capabilities beyond the existing UI redesign.
- Removed by request: separate timeline/event log.

## Remaining supplied documentation

- [About generative AI](https://cloudscape.design/gen-ai/): usefulness, user control and honest limitations.
- [Colors](https://cloudscape.design/gen-ai/foundation/colors/), [iconography](https://cloudscape.design/gen-ai/foundation/iconography/), [visual affordance](https://cloudscape.design/gen-ai/foundation/visual-affordance/): purple GenAI avatars, ordinary form-control colors, token-based themes, limited animation.
- [Components](https://cloudscape.design/gen-ai/components/): Avatar, ChatBubble, PromptInput, SupportPromptGroup and loading states.
- [Follow-up questions](https://cloudscape.design/gen-ai/patterns/follow-up-questions/) and [in-flow user input](https://cloudscape.design/gen-ai/patterns/in-flow-user-input/): focused input at the point it is needed and readable resolved decisions.
- [Loading states](https://cloudscape.design/gen-ai/patterns/generative-ai-loading-states/) and [progressive steps](https://cloudscape.design/gen-ai/patterns/progressive-steps/): real execution activity, explicit terminal states and indeterminate progress for unknown durations.
- [Output labels](https://cloudscape.design/gen-ai/patterns/generative-ai-output-label/): Generated by AI labels recommendation text, without relabeling sourced prices as generated facts.
- [In-chat context](https://cloudscape.design/gen-ai/patterns/in-chat-context/): preserve textual preferences and decision context. File upload and external-account connections require backend capabilities and are not offered.
- [Ingress](https://cloudscape.design/gen-ai/patterns/ingress/) and [pattern abstraction](https://cloudscape.design/gen-ai/patterns/pattern-abstraction/): explicit user initiation and a consistent input/work/output journey.
- [Support prompts](https://cloudscape.design/gen-ai/patterns/support-prompts/) and [variables](https://cloudscape.design/gen-ai/patterns/variables/): editable templates that the user reviews before sending.
- [Shortcut menus](https://cloudscape.design/gen-ai/patterns/shortcut-menus/): no slash/reference menus implying unsupported tools or resources.
- [Agent management](https://cloudscape.design/gen-ai/patterns/agent-management/): the existing model registry and role access remain authoritative; this is one deck agent, not an agent marketplace.
- [AI tools](https://cloudscape.design/gen-ai/ai-tools/) and [LLMs.txt files](https://cloudscape.design/gen-ai/ai-tools/llms-txt-files/): use official Markdown guidance and installed component API definitions.

## Verification

Frontend regression coverage exercises starter prompts without requests, rich artifact selection, history search and restoration, explicit consent and resume payloads, saved decisions, stopping, scroll preservation and prompt reuse. Existing model-selection, source, quotation, variant, authentication and admin tests remain in the suite. Browser checks use synthetic local fixtures for empty, working, waiting, completed, error and stopped states, including narrow screens and the existing appearance modes. Fixture results do not establish live supplier prices, deck legality or provider accounting.
