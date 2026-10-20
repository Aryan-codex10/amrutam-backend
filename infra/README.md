# Infrastructure

`../docker-compose.yml` is a local development stack only. Production needs managed PostgreSQL with private networking, HA/PITR and encryption; private Redis; gateway/WAF; workload identity; KMS; secret manager; and private metrics/OTel collection. The API container runs non-root, read-only, drops Linux capabilities, and exposes HTTP only to cluster ingress.

Recommended IaC modules: network, database, cache, gateway, secrets, observability, backup. Add policy checks for public database ingress, unencrypted storage, wildcard CORS, missing retention, and unpinned production image tags.
