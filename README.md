# Amrutam Telemedicine API

A backend reference implementation for identity, doctor availability, consultation booking and lifecycle, prescriptions, search, and administrative reporting. Source code is in `src/`, deployment assets in `infra/`, contracts in `api/` and `database/`, and reviewer documentation in `docs/`.

## Run locally

1. Copy `.env.example` to `.env`. Blank `PHI_ENCRYPTION_KEYS` and `EMAIL_LOOKUP_KEY` use fixed demo-only fallbacks; if you put generated values in either setting, those values are used even with `APP_ENV=development`. Keep the same values for the lifetime of that database. Never use the fixed demo keys for real data. Production must set `JWT_SECRET`, `PHI_ENCRYPTION_KEYS`, and a separate `EMAIL_LOOKUP_KEY` through a secret manager. Generate keys with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` and `python -c "import secrets; print(secrets.token_urlsafe(48))"`. The bundled database password is local development only.
2. If an older API container is already running, stop it first with `docker compose stop api`. Start the database and cache, build the API image, and initialize the schema:
   ```powershell
   docker compose up -d db redis
   docker compose build api
   docker compose run --rm api python scripts/migrate_existing_demo_db.py
   docker compose up -d api
   ```
   The migration command creates the schema on a fresh database and upgrades the earlier local demo schema in place. Back up existing local data first.
3. Visit `http://localhost:8000/docs`; health checks are `/health/live` and `/health/ready`.

The demo seed creates a ready-to-use admin, so you do not need the bootstrap command for the video walkthrough. To create your own first admin instead, start the API/database, set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (16+ characters) in PowerShell, then run the script inside the API container with `docker compose exec -e "BOOTSTRAP_ADMIN_EMAIL=$env:BOOTSTRAP_ADMIN_EMAIL" -e "BOOTSTRAP_ADMIN_PASSWORD=$env:BOOTSTRAP_ADMIN_PASSWORD" api python scripts/bootstrap_admin.py`. Unset both environment variables afterward. An admin can provision doctors via `POST /api/v1/admin/doctors`.

For the complete local demo dataset, with the API and database running, run `docker compose exec api python scripts/seed_demo.py --confirm`. This adds 20 synthetic accounts plus availability, consultations, and prescriptions. Demo logins and TOTP steps are listed in `docs/demo-seed-accounts.md`. The script requires `APP_ENV=development`, is safe to rerun, and does not remove or reset records. If you already created a separate bootstrap admin, that account is additional to the 20 seeded users.

The app encrypts stored email addresses, MFA secrets, consultation reasons, and prescription text. Email equality searches use a separate keyed HMAC digest. The local development encryption key is fixed so local records remain readable after restarts; production keys are required at startup. For local demo key rotation, back up the database, set `PHI_ENCRYPTION_KEYS` to `NEW_KEY,OLD_KEY` and set a new `EMAIL_LOOKUP_KEY` in `.env`, restart the API, then run `docker compose exec api python scripts/rotate_dev_keys.py`. The helper also retains the original fixed demo key during decryption and rewrites all stored fields with the new key. Production needs a reviewed, versioned rotation job and key custody through a managed service. Fernet supports decryption with a set of rotated keys; see the [official Fernet documentation](https://cryptography.io/en/stable/fernet/). Seed accounts use public deterministic TOTP secrets for the demo only.

### Existing local database upgrade

The earlier demo version stored email, visit reasons, and prescription text in plaintext. To preserve that local Compose database, keep the same local development keys that were used to encrypt it (the default development keys are stable), then run:

```powershell
docker compose stop api
docker compose build api
docker compose run --rm api python scripts/migrate_existing_demo_db.py
docker compose up -d api
```

The migration is development-only, PostgreSQL-only, and transactional. It encrypts legacy plaintext fields and rebuilds email lookup hashes from stored emails using the active lookup key. For already encrypted rows, it must be able to decrypt emails with the configured encryption key. Back up the local database first. `database/schema.sql` matches the ORM model for fresh databases; production deployments still need reviewed, versioned migrations and managed keys.

### Existing database encrypted with unavailable keys

If existing encrypted rows raise `InvalidToken`, the configured encryption key does not match the key that encrypted those rows. The email lookup key must also match for existing accounts to be found. If you only recently added generated keys and those settings were previously blank, clear both `PHI_ENCRYPTION_KEYS` and `EMAIL_LOOKUP_KEY` in `.env`; the stable development fallback keys will be used again. Recreate the API container so it reads the updated environment. Keep `JWT_SECRET` set: it does not encrypt database fields. The migration above only converts the earlier plaintext schema; it cannot recover encrypted data without the original encryption key. If clearing the settings does not restore access, restore the original key values from a backup if available. Otherwise, preserve the old Compose database and use a separate project name for a clean assignment demo database:

```powershell
docker compose stop api
docker compose -p amrutam-assignment up -d db redis
docker compose -p amrutam-assignment build api
docker compose -p amrutam-assignment run --rm api python scripts/migrate_existing_demo_db.py
docker compose -p amrutam-assignment up -d api
docker compose -p amrutam-assignment exec api python scripts/seed_demo.py --confirm
docker compose -p amrutam-assignment ps
```

This creates a separate named database volume and leaves the original Compose database volume intact. Continue to use `-p amrutam-assignment` on Compose commands for this demo stack. Do not use `down -v` if you need to preserve either database volume.

## Key paths

- `api/openapi.yaml` - API contract
- `database/schema.sql` - PostgreSQL schema and constraints
- `docs/architecture.md` - architecture, data flow, reliability, scale, backup/DR
- `docs/security-threat-model.md` - threat model, data classification, controls
- `docs/operations.md` - API management, observability, delivery and recovery
- `docs/demo-script.md` - five-minute walkthrough and recording cues
- `docs/demo-seed-accounts.md` - local demo users, passwords, and TOTP steps
- `infra/` - AWS Terraform reference deployment and infrastructure guide

## Scope notes

The runnable slice implements REST workflows with JWT authentication, bcrypt password hashing, required TOTP MFA for privileged APIs, encrypted email/clinical text/MFA secrets, keyed email lookup hashes, replay-resistant MFA codes, idempotent booking, transaction/row locking, audit events, input validation, structured logs, request IDs, Prometheus-format metrics, and auth throttling (Redis-backed when configured, process-local fallback otherwise). Payment processing, external video/notification providers, managed KMS integration, refresh-token rotation, public-search caching, and production migration management remain rollout work. No live provider or patient data is used.

## Run quality checks

Install `requirements-dev.txt`, then run `python -m unittest discover -s tests -v`. CI also checks dependencies and the container. See the security checklist before deployment.
