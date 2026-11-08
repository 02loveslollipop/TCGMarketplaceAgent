# Build Instructions

## Prerequisites and configuration

Use Python 3, Node.js, Docker Compose and the existing PostgreSQL service. Install Python dependencies with `python3 -m venv .venv` and `.venv/bin/python -m pip install -e '.[test]'`; install frontend dependencies with `npm install` in `frontend/`. Follow `deploy/README.md` for the private environment, restricted service roles and startup. Never expose the root `.env` or use the database administrator as an application runtime identity. Existing provisioning is complete: do not bootstrap or reset the administrator again.

## Build and verify

From `frontend/`, run `npm run build` (includes TypeScript checking). From the project root run `docker compose config --quiet`, `docker compose up --build -d --wait`, and `docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'`. Test commands and fixture restrictions are in `../code-generation/unit-test-instructions.md`. The prior rebuild and browser checks are documented in `../code-generation/integration-evidence.md`.

## Troubleshooting

If a service is unhealthy, inspect its redacted logs and configured runtime credentials without printing secrets. A provider or supplier failure does not establish a working live quotation; supplier retrieval requires only a configured Apify credential. Localhost is the configured WebAuthn origin; use the documented origin and RP configuration for any other environment.

The user enabled local password-only development mode for testing. Restore mandatory 2FA with `LOCAL_DEV_PASSWORD_ONLY=false docker compose up -d auth`. Consult `deploy/README.md` for mode and session behavior.
