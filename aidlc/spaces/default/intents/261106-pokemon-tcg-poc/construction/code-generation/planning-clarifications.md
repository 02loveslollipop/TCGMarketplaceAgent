# Implementation Planning Clarifications

Requirements Analysis was approved in message 7ac1886b. Cloudscape remains mandatory for the React interface. These questions resolve architecture choices explicitly left open by the approved requirements; no implementation choice is recorded until the requester answers.

## Q1. Which application stack should the PoC use?

- A. Python FastAPI backend with LangGraph/LangChain, React with TypeScript and Vite, and HTTPS SSE streaming. Recommended for this PoC.
- B. TypeScript Node.js backend with LangGraph.js/LangChain.js, React with TypeScript and Vite, and HTTPS SSE streaming.
- X. Other (please specify).

[Answer]: A. Python FastAPI backend with LangGraph/LangChain, React with TypeScript and Vite, and HTTPS SSE streaming.

## Q2. What should OAuth2 mean for this PoC?

- A. App-managed username/password login with JWTs and an OAuth2 token flow; no external identity provider.
- B. External OAuth2 login in addition to the required password and 2FA support; specify the provider, such as Google or GitHub.
- X. Other (please specify).

[Answer]: A. App-managed username/password login with JWTs and an OAuth2 token flow; no external identity provider.

## Additional architecture instruction

Source: user message 1ab54755.

> Q1: A - Q2: A (Use microservices for the authentication, admin portal, web app, orchestation, etc. And for now for local development use Docker Compose to orchestate it)

Implement independently runnable authentication, administration, web and agent-orchestration services. Use Docker Compose for local development. Keep the existing shared PostgreSQL database isolated to a new application schema and service runtime credentials; its admin connection is for provisioning only.

## Q3. First administrator setup

The dedicated schema has been provisioned and the private bootstrap command is ready. Run `.venv/bin/python -m scripts.bootstrap_admin` from the project directory to choose the initial username and enter its password privately in your terminal. Never send the password in chat.

- A. Done; the first administrator has been created locally.
- B. Later; continue independent build and UI verification.
- X. Other (please specify).

[Answer]: X. do it yourself we can rotate credentials later

The requester authorized generating the initial administrator credentials in message 1487329c. Store the generated password privately in ignored .runtime/ files with restrictive permissions; never print it or put it in this record. This supersedes the earlier requirement to wait for the requester to choose the initial identity.

## Runtime credential update

The requester added APIFY_API_KEY to the root .env for application use in message a78bfa54. Treat APIFY_API_KEY as the application runtime key and pass it only to the orchestration service. Never copy its value into this record, client code or logs.

## Q4. Final FIDO2 implementation and interactive testing

Steps 1–12 are complete. The local microservices are healthy, the initial administrator exists with private generated credentials, and real browser login, model administration, streamed clarification and history restoration passed. FIDO2 has deliberately not been implemented yet, following the request to leave this part last and ask for participation.

Are you ready for FIDO2 implementation and testing with both a key manager and a physical security key?

- A. Ready; proceed with implementation and test both methods together.
- B. Not ready yet; leave FIDO2 pending.
- X. Other (please specify).

[Answer]: A. Ready; proceed with implementation and test both methods together.

Confirmed in message 2ee467bf: use Playwright to interact with the application and test both Google Password Manager and a FIDO 2.0 physical key. Implement the final portion now, keeping automated/virtual-authenticator evidence separate from the requester's actual authenticator interactions.

The requester selected Google Password Manager on their phone for the actual credential test (message 7cb09033). Use Chrome's cross-device chooser rather than requiring a Google sign-in in the dedicated test profile.

## Login revision before FIDO2

The requester asked to redo the login to match /home/zerotwo/coa-puroseka-heroku (5b2b0886), then selected "Part of the active work" (7fcfd19b). Adapt that project's full-height split-screen presentation, dark branding panel and compact Cloudscape form to this app. The request does not answer the pending FIDO2 readiness question, which remains open. Implementation plan Step 13 records the requested revision; FIDO2 moves to the subsequent steps.

## Design references

- Cloudscape documentation: https://cloudscape.design/llms.txt (checked 2026-11-06). Use the documented React components and global styles, including the chat, prompt input, cards, tables and application layout components where applicable.
- Approved requirements: ../../inception/requirements-analysis/requirements.md
- Physical-key implementation and testing stays last; ask the requester to test both a key manager and a physical security key at that point.

## Q5. Actual phone enrollment result

The dedicated headed Chrome window is signed into the existing PoC administrator. A registration named Google Password Manager (phone) was started through the actual app UI. Chrome's native passkey chooser must be completed by the requester using their phone; the application cannot observe the phone's private unlock prompts.

Complete the phone/tablet QR flow and approve saving the credential in Google Password Manager. Did phone enrollment complete, or is the native dialog missing/showing an error?

- A. Completed phone enrollment.
- B. Dialog missing or an error appeared; describe the message.
- X. Other (please specify).

[Answer]: B. Dialog missing or an error appeared; describe the message. The requester was not watching and the phone enrollment timed out; restart the request (message 1041e367).

Registration and a fresh sign-in must be verified separately for both the phone and the physical key. The automated virtual-authenticator preflight is not evidence of either actual device test.

## Q6. Retried phone enrollment result

Restarted the registration through the UI after the requester reported timeout (1041e367). Fresh registration options returned HTTP 200; the dedicated Chrome window was brought to the foreground.

- A. Phone enrollment completed.
- B. An error appeared or the request timed out; describe the message.
- X. Other (please specify).

[Answer]: A. Phone enrollment completed. The requester confirmed that it worked in message ae21a75f. Further sign-in and physical-key evidence will be recorded from observed results separately.

## Q7. Mandatory first-login 2FA setup

For a new account's first login, must the user enroll an authenticator app or passkey/security key before accessing chat or administration?

- A. Require 2FA enrollment before access.
- B. Allow access and offer optional setup.
- X. Other (please specify).

[Answer]: A. Require 2FA enrollment before access. Confirmed in message 3082879a.

## Q8. Recovery method

Does recovery mean single-use backup codes, shown once and stored only as hashes, that replace the second factor after the correct password, alongside multiple passkeys and physical keys?

- A. Yes, single-use recovery codes.
- B. Spare physical security keys only.
- X. Other (please specify).

[Answer]: A. Yes, single-use recovery codes. Confirmed in message b57e1dbc.

The requested onboarding/recovery refinement is part of the active authentication implementation (ae21a75f). Existing multiple named WebAuthn credentials should be retained and verified; no enrolled credential is to be reset or removed to implement onboarding.
