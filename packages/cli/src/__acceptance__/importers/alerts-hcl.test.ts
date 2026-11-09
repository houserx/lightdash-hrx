/* eslint-disable */
// @ts-nocheck
// imp-alerts-hcl: the importer evaluates the Terraform the infra rule groups use: locals,
// for_each over toset(...) with each.key, dynamic "rule" blocks with for expressions and if
// filters, jsonencode({...}) models, merge(), tolist(), conditionals, arithmetic, string
// interpolation, heredocs and references to grafana_data_source resources.
import { CONTACT_POINTS_TF, LOCALS_TF, child, policy } from './alertsupport';
import { DATASOURCES_TF, calls, importGrafanaAlerts } from './support';

const RULES_TF = `
locals {
  envs = ["prod", "staging"]
  prom_by_env = {
    prod    = grafana_data_source.prometheus-production
    staging = grafana_data_source.prometheus-staging
  }
  extra_rules = [
    { key = "slow", name = "Slow requests", threshold = 2 * 1000, paused = false },
    { key = "very_slow", name = "Very slow requests", threshold = 10 * 1000, paused = true },
  ]
}

resource "grafana_rule_group" "latency" {
  for_each         = toset(local.envs)
  name             = "latency_\${each.key}"
  folder_uid       = grafana_folder.this["Platform"].uid
  interval_seconds = each.key == "prod" ? 60 : 300

  rule {
    name      = "API latency high - \${each.key}"
    condition = "C"
    for       = "5m"
    data {
      ref_id = "A"
      relative_time_range {
        from = 600
        to   = 0
      }
      datasource_uid = local.prom_by_env[each.key].uid
      model = jsonencode({
        expr  = "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{env=\\"\${each.key}\\"}[5m])))"
        refId = "A"
      })
    }
    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode(merge({ type = "reduce", expression = "A", refId = "B" }, { reducer = "max" }))
    }
    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        type       = "threshold"
        expression = "B"
        refId      = "C"
        conditions = [{ evaluator = { type = "gt", params = tolist([0.5]) } }]
      })
    }
    annotations = {
      summary     = "p99 latency above 500ms in \${each.key}"
      description = <<-EOT
        The API p99 latency in \${each.key} has been above 500ms for 5 minutes.
        Check the latency dashboard.
      EOT
    }
    labels = {
      team        = "infra"
      environment = each.key
    }
    no_data_state  = "OK"
    exec_err_state = "Error"
    is_paused      = false
  }

  dynamic "rule" {
    for_each = [for r in local.extra_rules : r if each.key == "prod"]
    content {
      name      = "\${rule.value.name} (\${each.key})"
      condition = "B"
      data {
        ref_id = "A"
        relative_time_range {
          from = 300
          to   = 0
        }
        datasource_uid = grafana_data_source.prometheus-production.uid
        model = "{\\"expr\\":\\"max(request_duration_ms)\\",\\"refId\\":\\"A\\"}"
      }
      data {
        ref_id = "B"
        relative_time_range {
          from = 0
          to   = 0
        }
        datasource_uid = "__expr__"
        model = jsonencode({
          type       = "classic_conditions"
          refId      = "B"
          conditions = [{ evaluator = { type = "gt", params = [rule.value.threshold] }, operator = { type = "and" }, query = { params = ["A"] }, reducer = { type = "last", params = [] }, type = "query" }]
        })
      }
      annotations = {
        summary = "\${rule.value.name} in \${each.key}"
      }
      labels = {
        team = "infra"
        key  = rule.value.key
      }
      no_data_state  = "NoData"
      exec_err_state = "Error"
      is_paused      = rule.value.paused
    }
  }
}
`;

let run: any;
beforeAll(async () => {
    run = await importGrafanaAlerts({
        rules: [{ name: 'latency.tf', text: RULES_TF }],
        contactPoints: { name: 'contact_points.tf', text: CONTACT_POINTS_TF },
        policy: { name: 'policy.tf', text: policy(child({ matchers: [['team', '=', 'infra']], contactPoint: 'pager', cont: true })) },
        locals: [{ name: 'locals.tf', text: LOCALS_TF }],
        extra: ['--datasources', DATASOURCES_TF],
    });
});
afterAll(() => run?.cleanup());

const byName = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);

describe('Terraform evaluation', () => {
    it('expands for_each and dynamic blocks', () => {
        const names = run.alertRules().map((r) => r.doc.name).sort();
        expect(names).toEqual(
            [
                'API latency high - prod',
                'API latency high - staging',
                'Slow requests (prod)',
                'Very slow requests (prod)',
            ].sort(),
        );
    });

    it('evaluates conditionals, locals and data source references', () => {
        expect(byName('API latency high - prod').interval).toBe('1m');
        expect(byName('API latency high - staging').interval).toBe('5m');
        const staging = calls(byName('API latency high - staging').query, 'promql_instant')[0] ?? calls(byName('API latency high - staging').query, 'promql')[0];
        expect(staging.args[0]).toContain('env="staging"');
        expect(staging.args[staging.args.length - 1]).toBe('prometheus-staging');
        expect(byName('API latency high - prod').labels).toMatchObject({ team: 'infra', environment: 'prod' });
    });

    it('evaluates jsonencode, merge, tolist and arithmetic', () => {
        const prod = byName('API latency high - prod');
        expect(prod.reducer).toBe('max');
        expect(prod.condition).toEqual({ operator: '>', threshold: 0.5 });
        expect(byName('Slow requests (prod)').condition).toEqual({ operator: '>', threshold: 2000 });
        expect(byName('Very slow requests (prod)').condition).toEqual({ operator: '>', threshold: 10000 });
        expect(byName('Very slow requests (prod)').paused).toBe(true);
        expect(byName('Slow requests (prod)').labels.key).toBe('slow');
    });

    it('reads heredocs and interpolated annotations', () => {
        const prod = byName('API latency high - prod');
        expect(prod.annotations.summary).toBe('p99 latency above 500ms in prod');
        expect(prod.annotations.description).toBe(
            'The API p99 latency in prod has been above 500ms for 5 minutes.\nCheck the latency dashboard.\n',
        );
    });
});
