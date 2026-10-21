# AWS Terraform reference deployment

This stack is the assignment's infrastructure-as-code deliverable. It describes an AWS reference deployment; it has **not** been applied to an AWS account. The local `docker-compose.yml` remains the no-cloud development environment.

## What it creates

- A two-AZ VPC with public load-balancer subnets, private API subnets, isolated database/cache subnets, and per-AZ NAT gateways.
- An HTTPS Application Load Balancer with HTTP-to-HTTPS redirect, an ACM certificate, strict API target health checks, and AWS WAF managed common rules plus per-IP rate limiting.
- An ECS Fargate API service with at least two tasks, a private security group, read-only root filesystem, deployment rollback, CPU autoscaling, and CloudWatch container insights/logs/alarms.
- Multi-AZ private PostgreSQL with encryption, backups, deletion protection, and access restricted to API tasks.
- Multi-AZ private Redis with in-transit/at-rest encryption, authentication, snapshots, and access restricted to API tasks.
- KMS-backed Secrets Manager values for database/Redis URLs, JWT signing, PHI encryption, and email lookup.

## Before planning an account deployment

Deployment can create billable NAT gateways, load balancers, Fargate tasks, RDS, Redis, KMS keys, and WAF resources. Do not run `terraform apply` merely to review the assignment. A real deployment needs an AWS account, approved region, ACM certificate, published container image in ECR, scoped operator permissions, and a reviewed cost estimate.

Terraform state contains database credentials and application secrets because the stack composes secret values. For shared or production use, configure the S3 backend with encryption, versioning, public access blocked, least-privilege access, and native S3 state locking before initialization. With Terraform 1.10+, initialize it using protected backend configuration such as `terraform init -backend-config="bucket=<state-bucket>" -backend-config="key=amrutam/staging/terraform.tfstate" -backend-config="region=ap-south-1" -backend-config="encrypt=true" -backend-config="use_lockfile=true"`. Create and secure the state bucket separately before this step. Protect access to state as tightly as Secrets Manager. Do not commit `.tfstate`, plan files, or real `.tfvars` files.

Supply `jwt_secret`, `phi_encryption_keys`, and `email_lookup_key` from protected CI variables or a secure local environment. Never use the public development/demo keys. `terraform.tfvars.example` contains placeholders only. The AWS deployment expects `CORS_ORIGINS` to contain explicit web origins.

## Validate without AWS credentials

From this directory, with Terraform 1.10+ installed:

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

GitHub Actions runs the same format and validation checks and builds the API container. No cloud deployment is triggered by CI.

## Plan/apply for an approved account

1. Publish the API image to ECR and use its immutable digest for `api_image_uri`.
2. Request an ACM certificate in the selected AWS region and complete domain validation.
3. Configure the secure remote S3 backend and then run `terraform init` with its protected backend configuration.
4. Provide all required inputs through protected variables; avoid writing secrets in a committed variable file.
5. Review `terraform plan` for network exposure, resource size, and estimated cost. Obtain deployment approval before `terraform apply`.
6. Apply the reviewed, versioned database migrations before shifting production traffic. The repository's convenience migration script is development-only and must not be used as a production migration process.
7. Verify `/health/ready`, `/metrics` access restrictions, WAF behavior, CloudWatch logs/alarms, database backups, and rollback behavior.

The Node.js API does not create production tables during startup. Fresh local databases and the prior demo schema use the explicit, development-only encryption migration script documented in the root README. Production schema changes need a separately reviewed versioned migration job and release sequence.
