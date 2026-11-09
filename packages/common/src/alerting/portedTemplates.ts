// The notification templates of today's Grafana (ENG-1799), ported verbatim
// from the infra repo's `grafana_message_template` resources
// (terraform-tooling/grafana_alert_message_template.tf @ bf3093da). Keep the
// sources byte-for-byte as in Grafana: their whitespace is part of the
// rendered Slack text. `renderAlertTemplate` makes their defines available
// to every template.

/** Grafana "Slack Message Template": `slack.message` and `slack.title`. */
const SLACK_MESSAGE_TEMPLATE = `{{ define "slack.message" }}
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
`;

/** Grafana "Slack MS Message Template": `slack.ms-message` and its helpers. */
const SLACK_MS_MESSAGE_TEMPLATE = `{{ define "__ms_text_alert_fired" }}
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
`;

/** Grafana "Slack Test Message Template": `test.slack.message` and `test.slack.title`. */
const SLACK_TEST_MESSAGE_TEMPLATE = `{{ define "test.slack.message" }}
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
`;

/** The ported Grafana message templates, keyed by their Grafana name. */
export const PORTED_GRAFANA_TEMPLATE_SOURCES: Readonly<Record<string, string>> =
    Object.freeze({
        'Slack Message Template': SLACK_MESSAGE_TEMPLATE,
        'Slack MS Message Template': SLACK_MS_MESSAGE_TEMPLATE,
        'Slack Test Message Template': SLACK_TEST_MESSAGE_TEMPLATE,
    });

/**
 * All ported Grafana message templates as one template source. Its defines
 * (`slack.title`, `slack.message`, `slack.ms-message`, `test.slack.title`,
 * `test.slack.message` and the `__ms_text_alert_*` helpers) are available
 * to every `renderAlertTemplate` call.
 */
export const PORTED_GRAFANA_TEMPLATES: string = Object.values(
    PORTED_GRAFANA_TEMPLATE_SOURCES,
).join('\n');
