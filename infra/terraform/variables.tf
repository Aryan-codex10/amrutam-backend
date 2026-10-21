variable "project_name" {
  description = "Short name used to tag and name resources."
  type        = string
  default     = "amrutam"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "staging"
}

variable "aws_region" {
  description = "AWS region for the stack."
  type        = string
  default     = "ap-south-1"
}

variable "api_image_uri" {
  description = "Immutable API image URI in ECR, preferably pinned by digest."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in this region for the HTTPS load balancer listener."
  type        = string
}

variable "jwt_secret" {
  description = "High-entropy JWT signing secret. Terraform state must be encrypted and access-controlled."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.jwt_secret) >= 32
    error_message = "jwt_secret must contain at least 32 characters."
  }
}

variable "phi_encryption_keys" {
  description = "Comma-separated Fernet keys; active key first. Use a production-managed secret."
  type        = string
  sensitive   = true
  validation {
    condition     = length(trimspace(var.phi_encryption_keys)) > 0
    error_message = "phi_encryption_keys must not be empty."
  }
}

variable "email_lookup_key" {
  description = "Independent high-entropy HMAC key for email lookup digests."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.email_lookup_key) >= 32
    error_message = "email_lookup_key must contain at least 32 characters."
  }
}

variable "allowed_api_cidrs" {
  description = "Client CIDRs allowed to reach the HTTPS API. Restrict this list where possible."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for the application VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "api_desired_count" {
  description = "Minimum number of API tasks."
  type        = number
  default     = 2
  validation {
    condition     = var.api_desired_count >= 2
    error_message = "At least two API tasks are required for multi-AZ availability."
  }
}

variable "api_max_count" {
  description = "Maximum number of API tasks for CPU-based scaling."
  type        = number
  default     = 6
  validation {
    condition     = var.api_max_count >= var.api_desired_count
    error_message = "api_max_count must be greater than or equal to api_desired_count."
  }
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance size."
  type        = string
  default     = "db.t4g.medium"
}

variable "redis_node_type" {
  description = "ElastiCache Redis node size."
  type        = string
  default     = "cache.t4g.micro"
}

variable "cors_origins" {
  description = "Comma-separated browser origins allowed by the API. Do not use a wildcard in production."
  type        = string
  validation {
    condition     = !strcontains(var.cors_origins, "*")
    error_message = "cors_origins must list explicit origins; wildcard CORS is not allowed."
  }
}
