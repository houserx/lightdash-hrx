resource "grafana_message_template" "this" {
  name     = "Slack Message Template"
  template = <<EOT
{{ define "slack.message" }}
    {{ range .Alerts.Firing }}
        {{ .Annotations.description }}
        {{ if .DashboardURL }}- <{{ .DashboardURL }}|Dashboard> {{ end }}
        {{ if .Annotations.runbook_url }}- <{{ .Annotations.runbook_url}}|Runbook>{{ end }}
    {{ end }}
{{ end }}

{{ define "slack.title" }}
    {{ if gt (len .Alerts.Firing) 0 }}
       {{ len .Alerts.Firing }} {{ (index .Alerts.Firing 0).Annotations.summary }}
    {{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "microservices" {
  name     = "Slack MS Message Template"
  template = <<EOT
{{ define "__ms_text_alert_fired" }}
  *Summary*: :fire: Microservice(s) have a high failure rate.
  *Microservices*:
  {{ range . }}   - {{ index .Labels "FunctionName" }} {{ if gt (len .SilenceURL) 0 }}(<{{ .SilenceURL }} | Silence>){{ end }}
  {{ end }}
{{ end }}

{{ define "__ms_text_alert_resolved" }}
  *Summary*: :white_check_mark: Microservice(s) resolved.
  *Microservices*:
  {{ range . }}   - {{ index .Labels "FunctionName" }}
  {{ end }}
{{ end }}

{{ define "slack.ms-message" }}
  {{ if gt (len .Alerts.Firing) 0 }}
    {{ template "__ms_text_alert_fired" .Alerts.Firing }}{{ if gt (len .Alerts.Resolved) 0 }}
{{- end }}{{- end }}
{{ if gt (len .Alerts.Resolved) 0 }}
{{ template "__ms_text_alert_resolved" .Alerts.Resolved }}
{{- end }}{{- end }}
EOT
}

resource "grafana_message_template" "test" {
  name     = "Slack Test Message Template"
  template = <<EOT
{{ define "test.slack.message" }}
{{ range .Alerts.Firing }}
        {{ .Annotations.description }}
        {{ if .DashboardURL }} - <{{ .DashboardURL }}|Dashboard> {{ end }}
        {{ if .Annotations.runbook_url }} - <{{ .Annotations.runbook_url}}|Runbook>{{ end }}
    {{ end }}
{{ end }}

{{ define "test.slack.title" }}
    {{ if gt (len .Alerts.Firing) 0 }}
       {{ len .Alerts.Firing }} {{ (index .Alerts.Firing 0).Annotations.summary }}
    {{ end }}
{{ end }}
EOT
}
