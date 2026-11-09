/* eslint-disable */
// @ts-nocheck
// Synthetic Terraform for the alert importer acceptance tests (protected). Shapes follow the
// infra snapshot's grafana_rule_group / grafana_contact_point / grafana_notification_policy.
import { DATASOURCES_TF, importGrafanaAlerts } from './support';

/** A Prometheus query data block for `ref_id`, as the infra rule groups write it. */
export const promData = (refId: string, expr: string, from = 600) => `
    data {
      ref_id = "${refId}"
      relative_time_range {
        from = ${from}
        to   = 0
      }
      datasource_uid = grafana_data_source.prometheus-production.uid
      model = jsonencode({
        datasource = { type = "prometheus", uid = grafana_data_source.prometheus-production.uid }
        expr       = ${JSON.stringify(expr)}
        refId      = "${refId}"
        instant    = true
      })
    }`;

/** A server-side expression data block (`__expr__`) with the given model attributes (HCL). */
export const exprData = (refId: string, modelHcl: string) => `
    data {
      ref_id = "${refId}"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        refId      = "${refId}"
        ${modelHcl}
      })
    }`;

/** reduce(A, last) then threshold(B > value): the infra snapshot's usual chain. */
export const reduceThreshold = (input = 'A', op = 'gt', value = 0, reducer = 'last') =>
    exprData('B', `type = "reduce"\n        expression = "${input}"\n        reducer = "${reducer}"`) +
    exprData(
        'C',
        `type = "threshold"\n        expression = "B"\n        conditions = [{ evaluator = { type = "${op}", params = [${value}] } }]`,
    );

/** One rule block. */
export const rule = (o: {
    name: string;
    data: string;
    condition?: string;
    for?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    noData?: string;
    execErr?: string;
    paused?: boolean;
    extra?: string;
}) => `
  rule {
    name      = ${JSON.stringify(o.name)}
    condition = "${o.condition ?? 'C'}"
    ${o.for ? `for = "${o.for}"` : ''}
${o.data}
    no_data_state  = "${o.noData ?? 'NoData'}"
    exec_err_state = "${o.execErr ?? 'Error'}"
    annotations = {
${Object.entries(o.annotations ?? {}).map(([k, v]) => `      ${k} = ${JSON.stringify(v)}`).join('\n')}
    }
    labels = {
${Object.entries(o.labels ?? {}).map(([k, v]) => `      ${JSON.stringify(k)} = ${JSON.stringify(v)}`).join('\n')}
    }
    is_paused = ${o.paused ? 'true' : 'false'}
    ${o.extra ?? ''}
  }`;

export const ruleGroup = (resource: string, rules: string[], o: { folder?: string; interval?: number; name?: string } = {}) => `
resource "grafana_rule_group" "${resource}" {
  name             = "${o.name ?? resource}"
  folder_uid       = grafana_folder.this["${o.folder ?? 'Platform'}"].uid
  interval_seconds = ${o.interval ?? 60}
${rules.join('\n')}
}
`;

/** Contact points: Slack ones read their webhook from locals; incident.io is a webhook. */
export const CONTACT_POINTS_TF = `
resource "grafana_contact_point" "slack-infra" {
  name = "slack-infra-alerts"
  slack {
    disable_resolve_message = false
    username                = "Grafana"
    url                     = local.grafana_infra_alerts_slack_url
    title                   = "{{ template \\"slack.title\\" . }}"
    text                    = "{{ template \\"slack.message\\" . }}"
  }
}

resource "grafana_contact_point" "slack-alerts" {
  name = "slack-alerts"
  slack {
    disable_resolve_message = true
    url                     = local.grafana_alerts_slack_url
  }
}

resource "grafana_contact_point" "slack-platform" {
  name = "slack-platform"
  slack {
    url = local.grafana_platform_slack_url
  }
}

resource "grafana_contact_point" "pager" {
  name = "pager"
  webhook {
    url                       = "https://api.incident.io/v2/alert_events/http/test-alert-source-not-real"
    http_method               = "POST"
    authorization_credentials = sensitive(data.aws_secretsmanager_secret_version.pager.secret_string)
  }
}

resource "grafana_contact_point" "slack-sec" {
  name = "slack-sec"
  slack {
    url = local.grafana_sec_slack_url
  }
}
`;

export const LOCALS_TF = `
locals {
  slack_webhooks                 = jsondecode(data.aws_secretsmanager_secret_version.grafana_slack_webhooks.secret_string)
  grafana_infra_alerts_slack_url = local.slack_webhooks.infra_alerts
  grafana_alerts_slack_url       = local.slack_webhooks.alerts
  grafana_platform_slack_url     = local.slack_webhooks.platform
  grafana_sec_slack_url          = local.slack_webhooks.security
}
`;

/** A notification policy with the given child policies (HCL), default slack-infra-alerts. */
export const policy = (children: string) => `
resource "grafana_notification_policy" "notification_policy" {
  group_by        = ["..."]
  contact_point   = grafana_contact_point.slack-infra.name
  group_wait      = "5s"
  group_interval  = "2m"
  repeat_interval = "1h"
${children}
}
`;

export const child = (o: { matchers: Array<[string, string, string]>; contactPoint: string; cont?: boolean; extra?: string }) => `
  policy {
${o.matchers.map(([label, match, value]) => `    matcher {\n      label = "${label}"\n      match = "${match}"\n      value = "${value}"\n    }`).join('\n')}
    contact_point = grafana_contact_point.${o.contactPoint}.name
    ${o.cont ? 'continue = true' : ''}
    ${o.extra ?? ''}
  }`;

/** Imports synthetic rule groups against the synthetic contact points and the given policy. */
export const importSynthetic = (rulesTf: string, policyTf: string, extra: string[] = [], options = {}) =>
    importGrafanaAlerts(
        {
            rules: [{ name: 'rules.tf', text: rulesTf }],
            contactPoints: { name: 'contact_points.tf', text: CONTACT_POINTS_TF },
            policy: { name: 'policy.tf', text: policyTf },
            locals: [{ name: 'locals.tf', text: LOCALS_TF }],
            extra: ['--datasources', DATASOURCES_TF, ...extra],
        },
        options,
    );
