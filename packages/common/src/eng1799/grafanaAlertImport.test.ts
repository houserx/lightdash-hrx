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
${rule('Ranged', promData('A', 'up') + exprData('C', 'type = "threshold"\n        expression = "A"\n        conditions = [{ evaluator = { type = "within_range_included", params = [0, 1] } }]'), 'is_paused = false')}
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

const convert = (policy = POLICY, rules = RULES) =>
    convertGrafanaAlerting({
        rules: [{ file: 'rules.tf', text: rules }],
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

    it('expands for_each and dynamic blocks', () => {
        const rules = `
locals {
  sources = { prod = grafana_data_source.prometheus-production }
}
resource "grafana_rule_group" "by_env" {
  for_each         = { prod = 2, dev = 1 }
  name             = "by_env_\${each.key}"
  folder_uid       = "x"
  interval_seconds = each.value * 90
  dynamic "rule" {
    for_each = [for n in ["a", "b"] : n if each.key == "prod" || n == "a"]
    iterator = r
    content {
      name      = "\${r.value} \${each.key} (\${r.key})"
      condition = "C"
      dynamic "data" {
        for_each = ["A"]
        content {
          ref_id         = data.value
          datasource_uid = local.sources[each.key].uid
          model          = jsonencode({ expr = "up", refId = "A", instant = true })
        }
      }
${reduceThreshold('gt', 1)}
      annotations = { summary = "s" }
    }
  }
}
resource "grafana_rule_group" "unknown" {
  for_each   = data.x.y
  name       = "u"
  folder_uid = "x"
}
`;
        const result = convert(POLICY, rules);
        expect(
            result.alertRules.map((r) => [r.name, r.interval, r.paused]),
        ).toEqual([
            ['a dev (0)', '90s', true],
            ['a prod (0)', '3m', false],
            ['b prod (1)', '3m', false],
        ]);
        // local.sources has no dev entry, so the dev rule (paused above) needs review; the prod
        // rules resolve the datasource through the local map of grafana_data_source resources.
        expect(result.alertRules[1].query).toContain("'prometheus-production'");
        expect(
            result.warnings.filter(
                (w) => w.path === 'grafana_rule_group.unknown',
            ),
        ).toEqual([expect.objectContaining({ code: 'terraform-unresolved' })]);
    });

    it('carries the folder space, for, window and no-data and error states', () => {
        const windowed = (from: number, to = 0) => `
    data {
      ref_id = "A"
      relative_time_range {
        from = ${from}
        to   = ${to}
      }
      datasource_uid = grafana_data_source.prometheus-production.uid
      model          = jsonencode({ expr = "up", refId = "A", instant = true })
    }`;
        const states = (noData: string, execErr: string) =>
            `no_data_state = "${noData}"\n    exec_err_state = "${execErr}"\n    annotations = { summary = "s" }`;
        const rules = `
resource "grafana_rule_group" "mesh" {
  name             = "mesh"
  folder_uid       = grafana_folder.this["Service Mesh"].uid
  interval_seconds = 120
${rule('Fields', windowed(900) + reduceThreshold('gt', 1), `for = "10m"\n    is_paused = true\n    ${states('OK', 'Alerting')}`)}
${rule('Keep', windowed(600, 60) + reduceThreshold('gt', 1), states('KeepLast', 'KeepLast'))}
${rule('Error OK', windowed(90) + reduceThreshold('gt', 1), `for = "soon"\n    ${states('NoData', 'OK')}`)}
}
resource "grafana_rule_group" "titled" {
  name       = "titled"
  folder_uid = grafana_folder.named["k8s"].uid
${rule('Titled', windowed(600) + reduceThreshold('gt', 1), states('Alerting', 'Error'))}
}
resource "grafana_rule_group" "literal" {
  name       = "literal"
  folder_uid = "osP4qAHIk"
${rule('Literal', windowed(600) + reduceThreshold('gt', 1), states('Maybe', 'Error'))}
}
`;
        const folders = `
resource "grafana_folder" "named" {
  for_each = { k8s = "Kubernetes Clusters" }
  title    = each.value
}
`;
        const result = convertGrafanaAlerting({
            rules: [{ file: 'rules.tf', text: rules }],
            contactPoints: { file: 'contact_points.tf', text: CONTACT_POINTS },
            policy: { file: 'policy.tf', text: POLICY },
            locals: [{ file: 'locals.tf', text: LOCALS }],
            folders: { file: 'folders.tf', text: folders },
            datasources: DATASOURCES,
        });
        result.alertRules.forEach((doc) =>
            expect(validateAlertingAsCode(doc).errors).toEqual([]),
        );
        const byName = (name: string) =>
            result.alertRules.find((r) => r.name === name);
        expect(byName('Fields')).toMatchObject({
            spaceSlug: 'service-mesh',
            for: '10m',
            interval: '2m',
            timeRange: '15m',
            noDataState: 'normal',
            errorState: 'alerting',
            paused: true,
            shadow: true,
        });
        expect(byName('Keep')).toMatchObject({
            timeRange: '10m',
            noDataState: 'keep_last',
            errorState: 'keep_last',
        });
        expect(byName('Error OK')).toMatchObject({
            timeRange: '90s',
            noDataState: 'nodata',
            errorState: 'keep_last',
        });
        expect(byName('Error OK')).not.toHaveProperty('for');
        expect(byName('Titled')).toMatchObject({
            spaceSlug: 'kubernetes-clusters',
            noDataState: 'alerting',
            errorState: 'error',
        });
        expect(byName('Literal')).not.toHaveProperty('spaceSlug');
        expect(byName('Literal')).not.toHaveProperty('noDataState');
        const codes = (ruleName: string) =>
            result.warnings
                .filter((w) => w.rule === ruleName)
                .map((w) => w.code);
        expect(codes('Error OK')).toEqual(
            expect.arrayContaining(['rule-state-changed', 'option-dropped']),
        );
        expect(codes('Keep')).toContain('option-dropped');
        expect(codes('Literal')).toContain('option-dropped');
        expect(
            result.warnings.filter(
                (w) => w.path === 'grafana_rule_group.literal',
            ),
        ).toEqual([expect.objectContaining({ code: 'terraform-unresolved' })]);
    });

    it('turns classic conditions and ranges into the reducer and condition', () => {
        const classic = (reducer: string, evaluator: string, extra = '') =>
            exprData(
                'C',
                `type = "classic_conditions"\n        conditions = [{ evaluator = ${evaluator}, operator = { type = "and" }, query = { params = ["A"] }, reducer = { type = "${reducer}", params = [] }, type = "query" }${extra}]`,
            );
        const lt3 = '{ type = "lt", params = [3] }';
        const rules = `
resource "grafana_rule_group" "conditions" {
  name             = "conditions"
  folder_uid       = grafana_folder.this["Platform"].uid
  interval_seconds = 60
${rule('Classic avg', promData('A', 'up') + classic('avg', lt3))}
${rule('Classic count', promData('A', 'up') + classic('count', '{ type = "outside_range", params = [1, 5] }'))}
${rule('Classic two', promData('A', 'up') + classic('avg', lt3, `, { evaluator = ${lt3}, operator = { type = "or" }, query = { params = ["A"] }, reducer = { type = "max", params = [] }, type = "query" }`))}
${rule('Classic median', promData('A', 'up') + classic('median', lt3))}
${rule('Hysteresis', promData('A', 'up') + exprData('C', 'type = "threshold"\n        expression = "A"\n        conditions = [{ evaluator = { type = "gt", params = [5] }, unloadEvaluator = { type = "lt", params = [2] } }]'))}
}
`;
        const result = convert(POLICY, rules);
        result.alertRules.forEach((doc) =>
            expect(validateAlertingAsCode(doc).errors).toEqual([]),
        );
        const [avg, count, two, median, hysteresis] = result.alertRules;
        expect(avg).toMatchObject({
            reducer: 'mean',
            condition: { operator: '<', threshold: 3 },
            paused: false,
        });
        expect(count).toMatchObject({
            reducer: 'count',
            condition: { operator: 'outside_range', min: 1, max: 5 },
            paused: false,
        });
        expect(two.paused).toBe(true);
        expect(median.paused).toBe(true);
        expect(hysteresis).toMatchObject({
            reducer: 'last',
            condition: { operator: '>', threshold: 5 },
            paused: false,
        });
        const codes = (ruleName: string) =>
            result.warnings
                .filter((w) => w.rule === ruleName)
                .map((w) => w.code);
        expect(codes('Classic avg')).not.toContain(
            'rule-null-handling-changed',
        );
        expect(codes('Classic count')).toContain('rule-null-handling-changed');
        expect(codes('Classic two')).toContain('rule-needs-review');
        expect(codes('Classic median')).toContain('rule-needs-review');
        expect(codes('Hysteresis')).toContain('expression-hysteresis-dropped');
    });

    it('evaluates math over queries in the SQL and pauses untranslatable expressions', () => {
        const threshold = (input: string) =>
            exprData(
                'C',
                `type = "threshold"\n        expression = "${input}"\n        conditions = [{ evaluator = { type = "gt", params = [5] } }]`,
            );
        const twoQueries =
            promData('A', 'errors') +
            promData('B', 'requests') +
            exprData(
                'M',
                'type = "math"\n        expression = "$A / $B * 100"',
            );
        const rules = `
resource "grafana_rule_group" "math" {
  name             = "math"
  folder_uid       = grafana_folder.this["Platform"].uid
  interval_seconds = 60
${rule('Math', twoQueries + exprData('D', 'type = "reduce"\n        expression = "$M"\n        reducer = "max"') + threshold('D'))}
${rule('Math direct', twoQueries + threshold('M'))}
${rule('Resample', promData('A', 'up') + exprData('D', 'type = "resample"\n        expression = "A"\n        window = "1m"') + threshold('D'))}
${rule('Math of reduces', promData('A', 'up') + exprData('B', 'type = "reduce"\n        expression = "A"\n        reducer = "last"') + exprData('D', 'type = "math"\n        expression = "$B * 2"') + threshold('D'))}
}
`;
        const result = convert(POLICY, rules);
        result.alertRules.forEach((doc) =>
            expect(validateAlertingAsCode(doc).errors).toEqual([]),
        );
        const [math, direct, resample, ofReduces] = result.alertRules;
        expect(math).toMatchObject({
            reducer: 'max',
            condition: { operator: '>', threshold: 5 },
            paused: false,
        });
        expect(math.query).toContain("promql_instant('errors'");
        expect(math.query).toContain("promql_instant('requests'");
        expect(math.query).toContain('"A"."value" / "B"."value" * 100');
        expect(direct).toMatchObject({ reducer: 'last', paused: false });
        expect(direct.query).toBe(math.query);
        [resample, ofReduces].forEach((doc) =>
            expect(doc).toMatchObject({
                query: PLACEHOLDER_ALERT_QUERY,
                paused: true,
                shadow: true,
            }),
        );
        const reviews = result.warnings
            .filter((w) => w.code === 'rule-needs-review')
            .map((w) => [w.rule, w.message]);
        expect(reviews).toEqual([
            ['Resample', expect.stringContaining('resample expression D')],
            [
                'Math of reduces',
                expect.stringContaining('one number per series'),
            ],
        ]);
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
        const { notificationRoutes, routingFixes, warnings } = convert();
        expect(notificationRoutes).toEqual({
            version: 1,
            type: 'notification_routes',
            contactPoint: 'slack-infra-alerts',
            groupBy: ['...'],
            groupWait: '5s',
            groupInterval: '2m',
            repeatInterval: '1h',
            routes: [
                // No policy names the hook contact point: the fix adds a notify route for it.
                {
                    matchers: [
                        { label: 'notify', operator: '=', value: 'hook' },
                    ],
                    contactPoint: 'hook',
                    continue: true,
                },
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
        expect(
            routingFixes.unreachedContactPoints.map((u) => u.contactPoint),
        ).toEqual(['hook']);
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

    it('resolves a datasource a data block looks up by name', () => {
        const cloudwatchData = (refId: string, lookup: string) => `
    data {
      ref_id         = "${refId}"
      datasource_uid = data.grafana_data_source.${lookup}.uid
      model = jsonencode({
        metricName = "UnHealthyHostCount"
        namespace  = "AWS/ApplicationELB"
        period     = "300"
        queryMode  = "Metrics"
        refId      = "${refId}"
        region     = "default"
        statistic  = "Average"
      })
    }`;
        const rules = `
data "grafana_data_source" "cw" {
  name = "Cloudwatch Production"
}
data "grafana_data_source" "by_uid" {
  uid = "JOxT6xE4z"
}
data "grafana_data_source" "missing" {
  name = "Nowhere"
}
resource "grafana_rule_group" "cw" {
  name             = "cw"
  folder_uid       = grafana_folder.this["AWS"].uid
  interval_seconds = 60
${rule('By name', cloudwatchData('A', 'cw') + reduceThreshold('gt', 0))}
${rule('By uid', cloudwatchData('A', 'by_uid') + reduceThreshold('gt', 0))}
${rule('Missing', cloudwatchData('A', 'missing') + reduceThreshold('gt', 0))}
}
`;
        const result = convertGrafanaAlerting({
            rules: [{ file: 'rules.tf', text: rules }],
            contactPoints: { file: 'contact_points.tf', text: CONTACT_POINTS },
            policy: { file: 'policy.tf', text: POLICY },
            locals: [{ file: 'locals.tf', text: LOCALS }],
            datasources: [
                ...DATASOURCES,
                {
                    uid: 'JOxT6xE4z',
                    name: 'Cloudwatch Production',
                    type: 'cloudwatch',
                },
            ],
        });
        const byName = (name: string) =>
            result.alertRules.find((r) => r.name === name);
        ['By name', 'By uid'].forEach((name) => {
            expect(byName(name)?.query).toContain('FROM cloudwatch(');
            expect(byName(name)?.query).toContain("'cloudwatch-production'");
            expect(byName(name)?.paused).toBe(false);
        });
        expect(byName('Missing')).toMatchObject({
            query: PLACEHOLDER_ALERT_QUERY,
            paused: true,
        });
        expect(
            result.warnings
                .filter((w) => w.rule === 'Missing')
                .map((w) => w.code),
        ).toContain('rule-needs-review');
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
