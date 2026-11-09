#####################################################################
# Contact points for Grafana to communicate with external services  #
#####################################################################

# For channel "#infra-alerts"
resource "grafana_contact_point" "slack-infra-contact-point" {
  name = "slack-infra-alerts"
  slack {
    disable_resolve_message = false
    username                = local.grafana_slack_username
    url                     = local.grafana_infra_alerts_slack_url
    title                   = "{{ template \"slack.title\" . }}"
    text                    = "{{ template \"slack.message\" . }}"
  }
}

# For channel "#alerts"
resource "grafana_contact_point" "slack-alert-contact-point" {
  name = "slack-alerts"
  slack {
    disable_resolve_message = true
    username                = local.grafana_slack_username
    url                     = local.grafana_alerts_slack_url
    title                   = "{{ template \"slack.title\" . }}"
    text                    = "{{ template \"slack.message\" . }}"
  }
}

# For channel "#test-slack-app"
resource "grafana_contact_point" "slack-test-contact-point" {
  name = "test-alerts"
  slack {
    disable_resolve_message = false
    username                = local.grafana_slack_username
    url                     = local.grafana_test_slack_url
    title                   = "{{ template \"test.slack.title\" . }}"
    text                    = "{{ template \"test.slack.message\" . }}"
  }
}

# incident.io contact point
resource "aws_secretsmanager_secret" "incident_io_grafana" {
  name        = "incident-io-grafana"
  description = "Authorization header credentials for incident.io Grafana webhook"
}

data "aws_secretsmanager_secret" "incident_io_grafana" {
  name = aws_secretsmanager_secret.incident_io_grafana.name
}

data "aws_secretsmanager_secret_version" "incident_io_grafana" {
  secret_id = data.aws_secretsmanager_secret.incident_io_grafana.id
}

resource "grafana_contact_point" "incident-io_default" {
  name = "Grafana Alerts (incident.io)"
  webhook {
    url         = "https://api.incident.io/v2/alert_events/http/test-alert-source-not-real"  # placeholder: the real alert source URL was removed from this fixture
    http_method = "POST"

    # Authorization Header - Credentials (fetched via data resource)
    authorization_credentials = sensitive(data.aws_secretsmanager_secret_version.incident_io_grafana.secret_string)

    disable_resolve_message = false
  }
}

# For security's channel
resource "grafana_contact_point" "slack-sec-contact-point" {
  name = "slack-sec"
  slack {
    disable_resolve_message = false
    username                = local.grafana_slack_username
    url                     = local.grafana_sec_slack_url
    title                   = "{{ template \"slack.title\" . }}"
    text                    = "{{ template \"slack.message\" . }}"
  }
}

# For channel "#alerts-swat" (SWA-1657's PA Renewal Health alerts)
#
# Reads a "swat_alerts" key from the grafana_slack_webhooks secret (see locals.tf -
# that secret is read via a data source only, not created/managed by this repo's
# Terraform), matching the existing infra_alerts/alerts/test/security keys. The
# webhook and secret key have already been created - no longer a pending step.
resource "grafana_contact_point" "slack-swat-contact-point" {
  name = "slack-alerts-swat"
  slack {
    disable_resolve_message = false
    username                = local.grafana_slack_username
    url                     = local.grafana_swat_alerts_slack_url
    title                   = "{{ template \"slack.title\" . }}"
    text                    = "{{ template \"slack.message\" . }}"
  }
}
