# Five-minute demo script

## Recording plan

**0:00-0:25 | Problem and design**  
“Amrutam needs a secure backend for 100,000 daily consultations, under-200 ms read and under-500 ms write p95 targets, and 99.95% availability. The design uses a stateless API, PostgreSQL as source of truth, Redis for ephemeral controls, and async extension points.” Show the architecture diagram.

**0:25-1:10 | Contracts and data model**  
Show `api/openapi.yaml`, then the ER diagram in `docs/architecture.md` and `database/schema.sql`. Briefly show `infra/terraform` as the AWS infrastructure-as-code reference. Point out state checks, indexes, and unique slot/idempotency constraints.

**1:10-2:20 | Identity and booking**  
Show the patient portal at `http://localhost:3000`: browse doctors, inspect availability, sign in, and book a slot. Then open `/docs`, show the same REST contract, and repeat a booking with the same `Idempotency-Key` to demonstrate replay. Explain row lock + transaction + unique constraints prevent double booking.

**2:20-3:15 | Consultation and prescription**  
Log in as `doctor01.demo@example.com` with the shared demo password and the current code from `docker compose exec api node backend/dist/scripts/demo-totp.js doctor01.demo@example.com`. Transition a consultation to `in_progress`, create a prescription, and show authorized access. Explain lifecycle checks and patient/assigned-doctor/admin authorization with audit events.

**3:15-4:05 | Operations and security**  
Show `/health/ready`, `/metrics`, request ID header, and JSON log output. Point out container hardening, CI dependency/Terraform checks, TOTP MFA and replay rejection, and encrypted email/clinical fields. Explain that Terraform describes an AWS deployment but has not been applied, and that production key custody belongs in managed KMS/HSM; use no patient data in the demo.

**4:05-5:00 | Scale and tradeoffs**  
“Booking writes remain strongly consistent in Postgres. Search is bounded and cacheable; analytics can move to a replica or warehouse. Notifications and payments use an outbox/saga so provider outages do not hold database transactions open. We partition after measured growth, and restore-test encrypted PITR backups against five-minute RPO and one-hour RTO.” Close with implemented scope and next production-hardening steps.

## Before recording

- Start the local stack and use synthetic records only.
- Keep API docs and architecture diagram ready; hide secrets and `.env`.
- Prepare local synthetic doctor/admin accounts; never submit a privileged bootstrap secret.
- Follow the script and label integrations that remain rollout work accurately.
