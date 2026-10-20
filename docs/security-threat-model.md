# Security checklist and threat model

## Trust boundaries and attack surface

- Public surface: API gateway, registration/login, search, availability, booking, and metrics. Restrict metrics to private scrape networks.
- Authenticated surface: doctor slot management, consultation status, prescriptions, and admin routes. Trust verified token claims plus current account state; never trust a client-supplied role or owner ID.
- Data stores: PostgreSQL contains identity and sensitive health data; Redis holds ephemeral keys; logs and backups can expose identifiers or PHI if uncontrolled.
- Planned integrations: identity/MFA, payment gateway, messaging/video vendors, observability platform, secrets/KMS. Require separate credentials, egress restrictions, signed webhooks, and a data-processing review.

## Data classification and controls

| Class | Examples | Required handling |
|---|---|---|
| Public | Doctor display name, specialty, open slots | TLS, validation, short-TTL cache |
| Internal | IDs, operational metrics | Access control, retention policy, avoid high-cardinality labels |
| Personal | Email, phone, account metadata | TLS, encrypted storage/backups, least privilege, retention/deletion process |
| Sensitive health | Visit reason, prescription, consultation link | KMS envelope encryption, strict row authorization, no logs/metrics, audited access |
| Secrets | JWT signing key, DB/provider credentials | Secret manager, rotation, never source-control or bake into images |

## Threats and mitigations (OWASP-oriented)

| Threat | Mitigation in slice | Production control/evidence |
|---|---|---|
| Broken access control / IDOR | Ownership and assigned-doctor checks; role dependency | Negative authorization tests for every resource; consider PostgreSQL RLS |
| Credential stuffing / weak passwords | bcrypt, 12-character minimum, generic login error | MFA for privileged users, breached-password checks, adaptive throttles/alerts |
| Injection | SQLAlchemy parameter binding, Pydantic validation | SAST/DAST and query review |
| Replay/double booking | Required idempotency key, row lock, uniqueness constraints | Durable idempotency ledger, request hash and retention policy |
| Sensitive data exposure | TLS expected at gateway, logs exclude request bodies | KMS envelope encryption, redaction tests, private metrics |
| Denial of service | Bounded pagination; gateway limits | Distributed token bucket by IP/account/route, load tests and autoscale caps |
| Misconfiguration / secret leak | `.env` ignored; non-root read-only container | Managed secret injection, image scan, IaC policy checks |
| Supply-chain compromise | Direct dependencies pinned | Hash lock, dependency scan, SBOM, signed images |
| Audit tampering | App generates audit entries for sensitive writes | Separate write-only audit role, immutable export, gap alerts |
| Insider misuse | RBAC and audit event generation | Break-glass workflow, just-in-time access, quarterly review |

## Security checklist before production

- [ ] Enforce TLS 1.2+ end to end, HSTS at edge, strict CORS allowlist.
- [ ] Replace demo JWT secret with KMS-backed signing; rotate keys with overlap.
- [ ] Add MFA for privileged accounts, session revocation, refresh rotation, and account recovery safeguards.
- [ ] Use least-privilege DB roles; separate migration/runtime roles; add RLS where useful.
- [ ] Encrypt PHI with envelope encryption, rotate data keys, and test key recovery.
- [ ] Redact PHI from logs, traces, errors, metric labels, and support exports.
- [ ] Apply WAF, per-account/IP quotas, payload limits, and abuse monitoring.
- [ ] Verify authorization with negative tests; protect admin routes with step-up auth.
- [ ] Verify provider webhooks (signature, timestamp, replay window); store no card data.
- [ ] Enable dependency/container/IaC scanning, SBOM, image signing, and patch SLAs.
- [ ] Define retention/deletion, consent, breach response, encrypted backups, and audit retention with compliance owner.

This design is not a legal compliance certification. Validate data residency, consent, retention, and regulatory requirements for the operating jurisdiction before using patient data.
