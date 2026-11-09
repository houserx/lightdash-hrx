# Sanitized fixture: only the type, name and uid of each grafana_data_source from the infra snapshot.
# URLs, json_data, secure_json_data and the aws_secretsmanager_* resources were removed (secrets and endpoints).

resource "grafana_data_source" "prometheus-tooling" {
  type = "prometheus"
  name = "Prometheus-Tooling"
  uid = "RnQB6bP4kz"
}

resource "grafana_data_source" "prometheus-staging" {
  type = "prometheus"
  name = "Prometheus-Staging"
  uid = "dW0QDuzIz"
}

resource "grafana_data_source" "prometheus-production" {
  type = "prometheus"
  name = "Prometheus-Production"
  uid = "tmTXpZC4k"
}

resource "grafana_data_source" "cloudwatch-staging" {
  type = "cloudwatch"
  name = "Cloudwatch Staging"
  uid = "uHbTebEVk"
}

resource "grafana_data_source" "cloudwatch-tooling" {
  type = "cloudwatch"
  name = "Cloudwatch Tooling"
  uid = "0cboexE4z"
}

resource "grafana_data_source" "cloudwatch-production" {
  type = "cloudwatch"
  name = "Cloudwatch Production"
  uid = "JOxT6xE4z"
}

resource "grafana_data_source" "loki-staging" {
  type = "loki"
  name = "Loki-Staging"
  uid = "90VZkvzIz"
}

resource "grafana_data_source" "loki-production" {
  type = "loki"
  name = "Loki-Production"
  uid = "GA4WkvzSz"
}

resource "grafana_data_source" "GitHub" {
  type = "grafana-github-datasource"
  name = "GitHub"
  uid = "betb591q7ij28b"
}

resource "grafana_data_source" "GitHub_main" {
  type = "grafana-github-datasource"
  name = "GitHub_main"
  uid = "GitHub"
}

resource "grafana_data_source" "sentry" {
  type = "grafana-sentry-datasource"
  name = "Sentry"
}
