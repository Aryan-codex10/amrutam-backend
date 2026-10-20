# Amrutam Telemedicine API

A backend reference implementation for identity, doctor availability, consultation booking and lifecycle, prescriptions, search, and administrative reporting. Source code is in `src/`, deployment assets in `infra/`, contracts in `api/` and `database/`, reviewer documentation in `docs/`.

## Run locally

1. Copy `.env.example` to `.env` and replace `JWT_SECRET` with a random secret of at least 32 bytes. The bundled database password is local development only.
2. Run `docker compose up --build`.
3. Visit `http://localhost:8000/docs`; health checks are `/health/live` and `/health/ready`.
4. `database/schema.sql` is the production data-model target, not a ready-to-apply migration for the demo ORM. Before production, add versioned migrations and align ORM mappings plus the PHI encryption adapter. The demo creates its own development tables at startup only in development.

For a local admin account, stop the API after its first startup, set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (16+ characters) in the environment, run `python scripts/bootstrap_admin.py`, then unset both values and restart. This command refuses to create a second admin. An admin can provision a doctor via `POST /api/v1/admin/doctors`; doctor credentials are bcrypt-hashed at creation.

## Key paths

- `api/openapi.yaml` - API contract
- `database/schema.sql` - PostgreSQL schema and constraints
- `docs/architecture.md` - architecture, data flow, reliability, scale, backup/DR
- `docs/security-threat-model.md` - threat model, data classification, controls
- `docs/operations.md` - API management, observability, delivery and recovery
- `docs/demo-script.md` - five-minute walkthrough and recording cues
- `infra/` - CI pipeline and deployment notes

## Scope notes

The runnable slice implements REST workflows with JWT authentication, role checks, password hashing, idempotent booking, transaction/row locking, audit events, input validation, structured logs, request IDs, Prometheus-format metrics, and authentication throttling (Redis-backed when configured, process-local fallback otherwise). Payment processing, external video/notification providers, managed key services, MFA enrollment, full refresh-token rotation, public-search caching, and production migrations are documented rollout work. No live provider or patient data is used.

## Run quality checks

Install `requirements-dev.txt`, then run `python -m unittest discover -s tests -v`. CI also checks dependencies and the container. See the security checklist before deployment.
