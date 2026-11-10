# Trimmed fixture of infra `terraform-tooling/locals.tf` (houserx/infra@bf3093da).
#
# Only the locals that the Grafana rule groups and contact points reference are kept. Everything
# else in the original file (VPC, account and zone references, IAM users, the Grafana API token)
# was removed. The Slack webhook locals still point at the Secrets Manager data source exactly as
# in the original, so no webhook URL appears here: an importer must turn them into secret
# references, never into values.

data "aws_secretsmanager_secret_version" "grafana_slack_webhooks" {
  secret_id = "grafana_slack_webhooks"
}

locals {
  region              = "us-east-2"
  dr_region_us_east_1 = "us-east-1"
  dr_region_us_west_2 = "us-west-2"

  # We use prod/production inconsistently
  grafana_prometheus_data_sources_env = {
    prod       = grafana_data_source.prometheus-production
    production = grafana_data_source.prometheus-production
    staging    = grafana_data_source.prometheus-staging
    tooling    = grafana_data_source.prometheus-tooling
  }

  # Environments where Envoy Gateway + SPIRE are deployed and should be alerted on.
  mesh_alert_environments = ["staging"]

  slack_webhooks = jsondecode(data.aws_secretsmanager_secret_version.grafana_slack_webhooks.secret_string)

  grafana_infra_alerts_slack_url = local.slack_webhooks.infra_alerts
  grafana_alerts_slack_url       = local.slack_webhooks.alerts
  grafana_test_slack_url         = local.slack_webhooks.test
  grafana_sec_slack_url          = local.slack_webhooks.security
  grafana_swat_alerts_slack_url  = local.slack_webhooks.swat_alerts
  grafana_slack_username         = "Grafana"
}
