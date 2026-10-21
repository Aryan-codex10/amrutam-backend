output "api_base_url" {
  description = "HTTPS base URL for the deployed API."
  value       = "https://${aws_lb.api.dns_name}"
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "database_endpoint" {
  description = "Private RDS endpoint; no public database ingress is configured."
  value       = aws_db_instance.main.address
}

output "redis_endpoint" {
  description = "Private Redis endpoint."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "api_log_group" {
  description = "CloudWatch log group for API container output."
  value       = aws_cloudwatch_log_group.api.name
}
