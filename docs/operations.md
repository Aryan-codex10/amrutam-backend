# Operations, API management, and delivery

## Service targets and signals

- Availability: 99.95%; monthly error budget about 22 minutes.
- Latency: p95 reads <200 ms and writes <500 ms, measured at gateway.
- Golden signals: request rate, error ratio, latency distributions, saturation, DB pool/locks/replication lag, Redis health, worker queue depth/age.
- `/metrics` exports Prometheus counters and histograms. JSON logs include request ID, method, normalized route, status and duration; no request body or clinical text. Add OpenTelemetry spans/propagation in platform rollout. Alert on SLO burn, DB saturation, queue age, backup failure, and authentication abuse.

## API management

Version routes under `/api/v1`; publish OpenAPI; use gateway for TLS, WAF, request size/time limits, quotas and access logs. Authenticate with short-lived bearer tokens. Combine RBAC with resource ownership. Require `Idempotency-Key` on booking. Keep errors stable and avoid leaking internals. Cap pagination at 100. Announce deprecation windows and use telemetry to track old versions. Restrict `/metrics` to internal scrape networks.

## Retry and asynchronous work

Retry only transient failures (timeouts, 429 honoring `Retry-After`, selected 5xx) with exponential backoff + full jitter, capped at 3-5 attempts and an overall deadline. Do not retry validation, authorization, or deterministic conflicts. Reuse the same idempotency key on retry. For jobs, persist an outbox event with the business transaction, lease with bounded visibility timeout, dedupe by event ID, dead-letter after max attempts, and provide audited replay tooling.

## Deployment and recovery

CI validates compilation, tests, dependencies, and container, and produces an SBOM in a release pipeline. Promote immutable images through staging then production with health-gated rolling/canary deployment and rollback on SLO regression. Schema changes follow expand-migrate-contract. Inject credentials through a secret manager. IaC should define private network, multi-zone managed PostgreSQL, Redis, gateway/WAF, workload identity, encrypted storage, backups, dashboards and alerts.

Use encrypted daily snapshots plus continuous WAL/PITR, with keys separate from the database. Restore quarterly into isolation. Proposed RPO <=5m / RTO <=60m. Document failover authority, write fencing, DNS/connection change, reconciliation, and stakeholder updates.
