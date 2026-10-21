# Amrutam Telemedicine Platform

A TypeScript and Node.js REST API with a small React demo interface. It covers patient registration, doctor discovery, appointment booking, clinician workflows, encrypted health data, MFA for privileged accounts, audit events, observability, Docker, CI, and AWS Terraform reference infrastructure.

## Start locally

Prerequisites: Docker Desktop with Compose. Copy `.env.example` to `.env` with `Copy-Item .env.example .env`. Keep encryption and lookup keys unchanged for the lifetime of an existing database. Blank `PHI_ENCRYPTION_KEYS` and `EMAIL_LOOKUP_KEY` use fixed demo-only fallbacks. Production must set `JWT_SECRET`, `PHI_ENCRYPTION_KEYS`, and a separate `EMAIL_LOOKUP_KEY` through a secret manager. Generate the Fernet-compatible key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url')+'=')"`. Generate the lookup key and JWT secret separately by running `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` once for each setting. The bundled database password and demo fallbacks are for local synthetic data only.

Start PostgreSQL and Redis, then build the Node API:

```powershell
docker compose up -d db redis
docker compose build api
```

For a new database or the earlier plaintext demo schema, run the development migration before starting the API. It creates missing tables and encrypts legacy PII in place; it does not reset the volume:

```powershell
docker compose run --rm api node backend/dist/scripts/migrate-existing-demo-db.js
docker compose up -d api web
```

Open [http://localhost:3000](http://localhost:3000) for the demo interface or [http://localhost:8000/docs](http://localhost:8000/docs) for Swagger. Health checks are `/health/live` and `/health/ready`.

## Seed synthetic demo data

With API/database available, run the idempotent seed:

```powershell
docker compose exec api node backend/dist/scripts/seed-demo.js --confirm
```

This provisions 20 accounts (one admin, five doctors, fourteen patients), doctor profiles, availability, sample consultations and prescriptions. It only inserts missing demo records. Login details and MFA instructions are in [docs/demo-seed-accounts.md](docs/demo-seed-accounts.md). Demo doctor/admin TOTP codes can be printed with `docker compose exec api node backend/dist/scripts/demo-totp.js doctor01.demo@example.com`. Seeded accounts use deterministic MFA secrets for demonstration only.

To create a different first admin, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the API environment and run `docker compose exec api node backend/dist/scripts/bootstrap-admin.js`. Admin accounts must enroll TOTP through `/api/v1/auth/mfa/setup` and `/api/v1/auth/mfa/verify` before privileged operations. Admins create clinicians through `POST /api/v1/admin/doctors`.

## Preserve and migrate existing local data

The database volume is named `pgdata` and is intentionally not deleted by these instructions. Keep the exact `PHI_ENCRYPTION_KEYS` and `EMAIL_LOOKUP_KEY` that were active when that volume was encrypted. To upgrade the prior Python demo, stop the API, rebuild the Node image, run the in-place migration, and start the API and frontend:

```powershell
docker compose stop api
docker compose build api
docker compose run --rm api node backend/dist/scripts/migrate-existing-demo-db.js
docker compose up -d api web
```

The migration is development-only and PostgreSQL-only. It encrypts plaintext email, consultation reasons, and prescription bodies, and rebuilds email lookup digests using the configured lookup key. It cannot recover encrypted values without their original encryption key. Back up the database before running it. The migration does not drop tables or volumes.

For local key rotation, set `PHI_ENCRYPTION_KEYS=NEW_KEY,OLD_KEY` and a new separate `EMAIL_LOOKUP_KEY`, restart the API with both encryption keys, then run `docker compose exec api node backend/dist/scripts/rotate-dev-keys.js`. Keep old keys until backups and all database copies have been re-encrypted and verified. Production rotation requires a reviewed migration and managed key custody.

## Development checks

Node.js 22.12+ and npm 10+ are required. Install and compile each package, then run backend unit and contract tests:

```powershell
npm ci --prefix backend
npm ci --prefix frontend
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix backend test
```

The REST integration test only runs when `TEST_DATABASE_URL` points to a dedicated database whose name includes `test`. To run it locally without touching the application database, start the isolated, temporary Compose test database and set the test-only connection:

```powershell
docker compose --profile testing up -d test-db
$env:TEST_DATABASE_URL = "postgres://amrutam_test:test_only_local@localhost:5433/amrutam_test"
npm --prefix backend test
Remove-Item Env:TEST_DATABASE_URL
docker compose --profile testing stop test-db
```

The test service stores its database in a container temporary filesystem; the normal `pgdata` volume is not mounted by the integration tests.

For hot reload, run `npm --prefix backend run dev` and `npm --prefix frontend run dev` in separate terminals after setting `DATABASE_URL` and `REDIS_URL` to services reachable from the host; the bundled Compose database is on its private network. The frontend development server proxies API calls to `http://localhost:8000`. CI runs builds, tests, dependency audits, both container builds, and Terraform format/validation checks. Terraform is a reference deployment and CI does not apply infrastructure.

## Deliverables and design

- [API contract](api/openapi.yaml) and interactive OpenAPI UI
- [PostgreSQL schema and ER model](database/schema.sql)
- [Architecture and reliability](docs/architecture.md)
- [Security threat model](docs/security-threat-model.md)
- [Operations, API management, and delivery](docs/operations.md)
- [Five-minute demo script](docs/demo-script.md)
- [Demo credentials and MFA walkthrough](docs/demo-seed-accounts.md)
- [AWS Terraform reference](infra/README.md)

PostgreSQL remains the source of truth. Fernet-compatible AES-CBC/HMAC field tokens preserve existing ciphertext; keyed HMAC digests support email equality lookup without plaintext storage. Passwords use bcrypt. JWTs are short-lived and signed with HS256. TOTP MFA is required for privileged actions, and counter replay is rejected. Booking uses a database transaction, locked availability row, unique slot and `(patient_id, idempotency_key)` constraints, and audit events. Authentication endpoints use Redis-backed throttling with a bounded process-local fallback. Logs avoid request bodies and redact bearer tokens.

Payments, third-party video/notification services, managed KMS integration, refresh-token rotation, production migration orchestration, and CI deployment remain explicitly documented rollout extensions. No real patient data or live provider is included.
