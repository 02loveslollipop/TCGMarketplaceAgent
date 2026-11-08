# Implementation Checkpoint

As of 2026-11-07, Code Generation steps 1–14 are complete, including the requested reference-inspired login revision and the requester's confirmation of readiness for FIDO2. WebAuthn implementation and automated checks are in place. The requester confirmed the retried phone enrollment worked; the saved phone credential was observed in the authenticated UI. Mandatory onboarding and recovery-code refinements are now in progress, with actual physical-key verification still pending. This is not a stage-completion approval or a claim that the full PoC is complete.

## Running application

- Chat: http://localhost:8080/
- Separate admin portal: http://localhost:8080/admin/
- Six healthy Docker Compose runtime services: gateway, web, admin-portal, auth, admin-api and orchestrator.
- Generated initial administrator credentials are stored only in ignored .runtime/bootstrap-admin.json, mode 0600. They were authorized by the requester and their password was not printed in chat or logs.
- Model presets are seeded disabled; administrators enable allowed models through the portal. The browser smoke temporarily enabled GPT 6 luna and restored its previous state.
- Run/setup instructions: [deploy/README.md](../../../../../../../deploy/README.md).

## Verified outcomes

- 42 Python tests and 7 frontend tests passed; TypeScript and the production frontend build passed.
- Real browser checks passed for administrator login, allowed-model administration, actual GPT 6 luna/LangGraph clarification over SSE, PostgreSQL persistence, history restoration and cancellation. Test sessions were revoked afterward.
- Both portals now share the full-height split login adapted from /home/zerotwo/coa-puroseka-heroku, with Pokémon branding, Cloudscape controls and a stacked mobile layout. The revised frontend passed its 7 existing tests (including TOTP behavior), TypeScript and the production build. A targeted actual-browser run passed all 12 checks, including keyboard login to both portals, invalid-credential errors, sign-out, desktop/mobile layout and absence of runtime exceptions. Final desktop/mobile screenshots were inspected. Only web and admin-portal were rebuilt/recreated; all six services are healthy.
- Dedicated-schema database provisioning and idempotence succeeded. Service-specific runtime credentials were exercised, with writes rolled back during permission checks. No other projects' schemas were read or used.
- Both requested OpenAI models succeeded through the actual LangChain model factory. Free search/card catalog tools succeeded. Apify runtime credentials authenticated without an Actor run.
- Full evidence and limits: integration-evidence.md; screenshots: workspace output/playwright/.

## Pending work and limits

- WebAuthn implementation passed 63 Python tests, 11 frontend tests, TypeScript/build and eight browser preflight assertions with a separate virtual authenticator. The temporary-account cleanup failure was repaired and the one fixture account disabled; see integration-evidence.md for the exact distinction. Google Password Manager (phone) enrollment was confirmed and its saved credential observed; the physical key still needs registration/sign-in verification.
- Requested refinements are recorded as FR9a–FR9c and plan steps 16–18: mandatory 2FA enrollment before access (3082879a), single-use recovery codes (b57e1dbc), and verification of multiple enrolled keys (ae21a75f). Implementation is delegated; root owns the actual browser fixture checks. Preserve the existing real phone credential. Finish interactive device checks after the refinements and final stage outputs/review in Step 19.
- Complete the final code summary/traceability, independent review and Code Generation approval after the implementation is finished. Build and Test follows its own stage.
- Live supplier retrieval and a completed live 60-card deck have not been exercised in tests. Returned reference prices are not purchasable offers.
- Mistral model discovery succeeded, but its inference check on 2026-11-06 returned HTTP 429. No provider fallback is used.
