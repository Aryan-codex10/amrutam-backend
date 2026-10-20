# Demo seed accounts

Run the seed script only against a local development database. It creates 20 synthetic accounts: one admin, five doctors, and fourteen patients. It also creates five doctor profiles, ten future availability slots, five consultations in different lifecycle states, and prescriptions for eligible consultations. All records are synthetic and contain no real patient information.

| Role | Accounts | Password |
|---|---|---|
| Admin | `admin.demo@example.com` | `Demo-Admin-2026!` |
| Doctor | `doctor01.demo@example.com` through `doctor05.demo@example.com` | `Demo-Doctor-2026!` |
| Patient | `patient01.demo@example.com` through `patient14.demo@example.com` | `Demo-Patient-2026!` |

Use `POST /api/v1/auth/login` to get a bearer token, then authorize the role's requests in `/docs`. Passwords are deliberately public demo credentials: never use them outside a local synthetic-data environment.

The script uses stable IDs and email addresses. Re-running it skips existing users and creates missing related seed records without duplicating the fixed sample appointments. It does not delete or reset existing data. If you already created a separate admin with the bootstrap script, that account remains in addition to these 20 demo accounts.
