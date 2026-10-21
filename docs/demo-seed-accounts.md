# Demo seed accounts

Run the seed script only against a local development database. It creates 20 synthetic accounts: one admin, five doctors, and fourteen patients. It also creates five doctor profiles, ten future availability slots, five consultations in different lifecycle states, and prescriptions for eligible consultations. All records are synthetic and contain no real patient information.

| Role    | Accounts                                                          | Password             |
| ------- | ----------------------------------------------------------------- | -------------------- |
| Admin   | `admin.demo@example.com`                                          | `Demo-Admin-2026!`   |
| Doctor  | `doctor01.demo@example.com` through `doctor05.demo@example.com`   | `Demo-Doctor-2026!`  |
| Patient | `patient01.demo@example.com` through `patient14.demo@example.com` | `Demo-Patient-2026!` |

Patient accounts log in with `email` and `password`. Seeded admin and doctor accounts also require a current six-digit TOTP code. To print the current local demo code, run `docker compose exec api node backend/dist/scripts/demo-totp.js admin.demo@example.com` or pass one of the doctor emails. Submit it as `totp_code` in `POST /api/v1/auth/login`. Codes change every 30 seconds; rerun the command if one expires. Then authorize requests in `/docs` with the returned bearer token.

Passwords and TOTP secrets are deliberately public demo credentials: never use these accounts outside a local synthetic-data environment. The seed TOTP secret is deterministically derived from the public demo email solely to make a short recording easier. Real accounts should enroll a private authenticator secret through `/api/v1/auth/mfa/setup` and `/api/v1/auth/mfa/verify`.

The script uses stable IDs and email addresses. Re-running it skips existing users and creates missing related seed records without duplicating the fixed sample appointments. It does not delete or reset existing data. If you already created a separate admin with the bootstrap script, that account remains in addition to these 20 demo accounts.
