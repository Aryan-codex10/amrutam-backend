# Infrastructure

- `../docker-compose.yml` runs the local development stack; it does not create cloud infrastructure.
- `terraform/` contains an AWS reference deployment for the production shape: VPC, private API/data tiers, ECS Fargate, ALB/WAF, PostgreSQL, Redis, KMS/Secrets Manager, autoscaling, and CloudWatch observability.
- The Terraform stack has not been deployed. See `terraform/README.md` for prerequisites, state protection, validation, and deployment cautions.

The API image runs non-root, read-only, drops Linux capabilities, and listens behind the ingress layer. Production schema changes require a separate versioned migration process.
