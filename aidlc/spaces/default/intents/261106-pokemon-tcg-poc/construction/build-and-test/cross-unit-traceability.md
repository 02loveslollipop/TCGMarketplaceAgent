# Cross-Unit Traceability

The zero-Unit stage-level traceability check returned `pass: true` with no uncovered IDs for the 14 IDs below. This establishes a file mapping, not correct behavior or live integration. FR9a–FR9c were separately added as authentication refinements and are recorded below because the sensor output did not enumerate them.

| Requirement | Code-generation target | Coverage caveat |
|---|---|---|
| FR1 | services/orchestrator/agent.py | Fixture/API checks |
| FR2 | services/orchestrator/research.py | Complete live deck unverified |
| FR3 | services/orchestrator/suppliers.py | Fixture/API checks; live retrieval not exercised |
| FR4 | services/orchestrator/budget.py | Shared-stock allocation regression passes |
| FR5 | frontend/src/DecisionPanel.tsx | Frontend unit checks use a DOM emulator |
| FR6 | tests/test_budget.py | Shared-stock and variant regressions pass |
| FR7 | frontend/src/Chat.tsx | Chromium smoke evidence recorded separately |
| FR8 | services/admin/app.py | Service and UI checks |
| FR9 | services/auth/security.py | Device choices user-assisted |
| FR10 | scripts/provision.py | Dedicated schema and roles only |
| NFR1 | tests/test_security.py | Temporary account password was exposed |
| NFR2 | tests/test_suppliers.py | Fixture checks; live retrieval not exercised |
| NFR3 | tests/test_repository.py | PostgreSQL fixture evidence separate |
| NFR4 | frontend/src/__tests__/chat.test.tsx | DOM emulator; separate Chromium evidence |
| FR9a | tests/test_onboarding_recovery.py | PostgreSQL and Chromium fixture checks also passed |
| FR9b | tests/test_onboarding_recovery.py | PostgreSQL race and Chromium fixture checks also passed |
| FR9c | tests/test_webauthn.py | Two virtual keys and separate user-assisted device sign-ins |

Uncovered by the sensor's enumerated file mapping: none. Live supplier coverage has not been exercised.
