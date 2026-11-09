import { validateAlertingAsCode } from '../alerting/asCode';
import {
    convertGrafanaAlerting,
    GrafanaAlertingImportError,
    PLACEHOLDER_ALERT_QUERY,
    renderGrafanaAlertsImportReport,
} from './grafanaAlertImport';

const promData = (refId: string, expr: string) => `
    data {
      ref_id         = "${refId}"
      datasource_uid = grafana_data_source.prometheus-production.uid
      model = jsonencode({
        datasource = { type = "prometheus", uid = grafana_data_source.prometheus-production.uid }
        expr       = ${JSON.stringify(expr)}
        refId      = "${refId}"
        instant    = true
      })
    }`;

const exprData = (refId: string, model: string) => `
    data {
      ref_id         = "${refId}"
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        refId      = "${refId}"
        ${model}
      })
    }`;

const reduceThreshold = (op: string, value: number, reducer = 'last') =>
    exprData(
        'B',
        `type = "reduce"\n        expression = "A"\n        reducer = "${reducer}"`,
    ) +
    exprData(
        'C',
        `type = "threshold"\n        expression = "B"\n        conditions = [{ evaluator = { type = "${op}", params = [${value}] } }]`,
    );

const rule = (name: string, data: string, extra = '') => `
  rule {
    name      = ${JSON.stringify(name)}
    condition = "C"
${data}
    ${extra}
  }`;

const RULES = `
resource "grafana_rule_group" "api" {
  name             = "api"
  folder_uid       = grafana_folder.this["Platform"].uid
  interval_seconds = 60
${rule('API down', promData('A', 'up{job="api"}') + reduceThreshold('lt', 1), 'annotations = { summary = "The API is down" }\n    labels = { team = "infra", "bad-name" = "x" }')}
${rule('API down', promData('A', 'up') + reduceThreshold('gt', 5, 'mean'))}
${rule('Ranged', promData('A', 'up') + exprData('C', 'type = "threshold"\n        expression = "A"\n        conditions = [{ evaluator = { type = "within_range", params = [0, 1] } }]'), 'is_paused = false')}
}
`;

const CONTACT_POINTS = `
resource "grafana_contact_point" "infra" {
  name = "slack-infra-alerts"
  slack {
    url                     = local.infra_url
    title                   = "{{ template \\"slack.title\\" . }}"
    disable_resolve_message = false
  }
}
resource "grafana_contact_point" "pager" {
  name = "Pager (incident.io)"
  webhook {
    url                       = "https://api.incident.io/v2/alert_events/http/not-real"
    authorization_credentials = sensitive(data.aws_secretsmanager_secret_version.pager.secret_string)
  }
}
resource "grafana_contact_point" "hook" {
  name = "hook"
  webhook {
    url         = "https://example.invalid/hook"
    http_method = "PUT"
  }
}
resource "grafana_contact_point" "pagerduty" {
  name = "pagerduty"
  pagerduty {
    integration_key = "x"
  }
}
`;

const LOCALS = `
locals {
  webhooks  = jsondecode(data.aws_secretsmanager_secret_version.webhooks.secret_string)
  infra_url = local.webhooks.infra
}
`;

const POLICY = `
resource "grafana_notification_policy" "policy" {
  group_by        = ["..."]
  contact_point   = grafana_contact_point.infra.name
  group_wait      = "5s"
  group_interval  = "2m"
  repeat_interval = "1h"
  policy {
    matcher {
      label = "team"
      match = "="
      value = "infra"
    }
    contact_point = grafana_contact_point.pager.name
    continue      = true
    policy {
      matcher {
        label = "severity"
        match = "=~"
        value = "crit.*"
      }
      repeat_interval = "forever"
    }
  }
}
`;

const DATASOURCES = [
    { uid: 'tmTXpZC4k', name: 'Prometheus-Production', type: 'prometheus' },
];

const convert = (policy = POLICY) =>
    convertGrafanaAlerting({
        rules: [{ file: 'rules.tf', text: RULES }],
        contactPoints: { file: 'contact_points.tf', text: CONTACT_POINTS },
        policy: { file: 'policy.tf', text: policy },
        locals: [{ file: 'locals.tf', text: LOCALS }],
        datasources: DATASOURCES,
    });

describe('convertGrafanaAlerting', () => {
    it('emits valid shadow alert rules with unique slugs', () => {
        const result = convert();
        expect(result.alertRules.map((r) => r.slug)).toEqual([
            'api-down',
            'api-down-2',
            'ranged',
        ]);
        [
            ...result.alertRules,
            ...result.contactPoints,
            result.notificationRoutes,
        ].forEach((doc) =>
            expect(validateAlertingAsCode(doc).errors).toEqual([]),
        );
        const [down, mean, ranged] = result.alertRules;
        expect(down).toMatchObject({
            name: 'API down',
            description: 'The API is down',
            labels: { team: 'infra' },
            reducer: 'last',
            condition: { operator: '<', threshold: 1 },
            paused: false,
            shadow: true,
        });
        expect(down.query).toContain("'prometheus-production'");
        expect(mean).toMatchObject({
            reducer: 'mean',
            condition: { operator: '>', threshold: 5 },
        });
        // Not translated yet: emitted paused, with a placeholder query and a warning.
        expect(ranged).toMatchObject({ paused: true, shadow: true });
        const codes = (ruleName: string) =>
            result.warnings
                .filter((w) => w.rule === ruleName)
                .map((w) => w.code);
        expect(codes('Ranged')).toEqual(
            expect.arrayContaining([
                'rule-needs-review',
                'rule-description-generated',
            ]),
        );
        expect(codes('API down')).toContain('label-invalid');
        expect(ranged.query).not.toBe(PLACEHOLDER_ALERT_QUERY);
    });

    it('turns contact points into integrations with secret references only', () => {
        const result = convert();
        expect(result.contactPoints.map((c) => c.slug)).toEqual([
            'slack-infra-alerts',
            'pager-incident-io',
            'hook',
        ]);
        expect(result.contactPoints[0].integrations).toEqual([
            {
                type: 'slack_webhook',
                url: { secretRef: 'slack-infra-alerts-webhook' },
                title: '{{ template "slack.title" . }}',
                disableResolveMessage: false,
            },
        ]);
        expect(result.contactPoints[1].integrations).toEqual([
            {
                type: 'incident_io',
                url: 'https://api.incident.io/v2/alert_events/http/not-real',
                token: { secretRef: 'pager-incident-io-token' },
            },
        ]);
        expect(JSON.stringify(result.contactPoints)).not.toMatch(
            /secret_string|local\./,
        );
        const paths = result.warnings.map((w) => `${w.code} ${w.path}`);
        expect(paths).toEqual(
            expect.arrayContaining([
                'option-dropped grafana_contact_point.hook',
                'contact-point-integration-unsupported grafana_contact_point.pagerduty',
                'contact-point-skipped grafana_contact_point.pagerduty',
            ]),
        );
    });

    it('turns the notification policy into the route tree', () => {
        const { notificationRoutes, warnings } = convert();
        expect(notificationRoutes).toEqual({
            version: 1,
            type: 'notification_routes',
            contactPoint: 'slack-infra-alerts',
            groupBy: ['...'],
            groupWait: '5s',
            groupInterval: '2m',
            repeatInterval: '1h',
            routes: [
                {
                    matchers: [
                        { label: 'team', operator: '=', value: 'infra' },
                    ],
                    contactPoint: 'pager-incident-io',
                    continue: true,
                    routes: [
                        {
                            matchers: [
                                {
                                    label: 'severity',
                                    operator: '=~',
                                    value: 'crit.*',
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        expect(warnings.map((w) => w.path)).toContain(
            'grafana_notification_policy.policy.policy[0].policy[0]',
        );
    });

    it('fails, naming the file, when there is no policy or its contact point is unknown', () => {
        expect(() => convert('# nothing here\n')).toThrow(
            GrafanaAlertingImportError,
        );
        expect(() => convert('# nothing here\n')).toThrow('policy.tf');
        expect(() =>
            convert(
                'resource "grafana_notification_policy" "p" {\n  contact_point = grafana_contact_point.nope.name\n}\n',
            ),
        ).toThrow('policy.tf');
        expect(() =>
            convertGrafanaAlerting({
                rules: [{ file: 'broken.tf', text: 'a = "open\n' }],
                contactPoints: {
                    file: 'contact_points.tf',
                    text: CONTACT_POINTS,
                },
                policy: { file: 'policy.tf', text: POLICY },
            }),
        ).toThrow('broken.tf');
    });

    it('reports every warning in IMPORT-REPORT.md', () => {
        const result = convert();
        const report = renderGrafanaAlertsImportReport(result);
        expect(report).toContain('3 alert rules, 3 contact points');
        expect(
            report
                .split('\n')
                .filter(
                    (l) =>
                        l.startsWith('| ') &&
                        !l.startsWith('| Code') &&
                        !l.startsWith('| ---'),
                ),
        ).toHaveLength(result.warnings.length);
    });
});
