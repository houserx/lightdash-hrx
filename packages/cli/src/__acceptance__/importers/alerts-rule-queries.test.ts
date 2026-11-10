/* eslint-disable */
// @ts-nocheck
// imp-alert-rule-queries: a rule's query data (Prometheus, Loki, CloudWatch) becomes the
// rule's SQL through the same query translation as the dashboards, over the reserved time
// parameters the evaluator fills in, with the Telemetry Source named after the datasource.
import { exprData, importSynthetic, policy, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { calls, isTimeRangeAware } from './support';

const loki = `
    data {
      ref_id = "A"
      relative_time_range {
        from = 86400
        to   = 0
      }
      datasource_uid = grafana_data_source.loki-production.uid
      model          = "{\\"datasource\\":{\\"type\\":\\"loki\\",\\"uid\\":\\"\${grafana_data_source.loki-production.uid}\\"},\\"editorMode\\":\\"code\\",\\"expr\\":\\"sum by (client_name) (count_over_time({job=\\\\\\"auth0-logs\\\\\\"} [24h]))\\",\\"queryType\\":\\"instant\\",\\"refId\\":\\"A\\"}"
    }`;
const cloudwatch = `
    data {
      ref_id = "A"
      relative_time_range {
        from = 1800
        to   = 0
      }
      datasource_uid = data.grafana_data_source.cloudwatch_production.uid
      model = jsonencode({
        dimensions = { LoadBalancer = "app/platform-prod/abc" }
        metricName = "UnHealthyHostCount"
        namespace  = "AWS/ApplicationELB"
        period     = "300"
        queryMode  = "Metrics"
        refId      = "A"
        region     = "default"
        statistic  = "Average"
        metricQueryType  = 0
        metricEditorMode = 0
      })
    }`;

const RULES = `
data "grafana_data_source" "cloudwatch_production" {
  name = "Cloudwatch Production"
}
${ruleGroup('queries', [
    rule({ name: 'Loki rule', data: loki + reduceThreshold('A', 'gt', 75000), annotations: { summary: 'Loki' } }),
    rule({ name: 'CloudWatch rule', data: cloudwatch + reduceThreshold('A', 'gt', 0), annotations: { summary: 'CloudWatch' } }),
])}`;

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, policy(''));
});
afterAll(() => run?.cleanup());

const byName = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);

describe('alert rule queries', () => {
    it('translates a Loki metric query', () => {
        const doc = byName('Loki rule');
        const call = calls(doc.query, 'logql_metric')[0];
        expect(call.args[0]).toBe('sum by (client_name) (count_over_time({job="auth0-logs"} [24h]))');
        expect(call.args[call.args.length - 1]).toBe('loki-production');
        expect(doc.query).toContain('${ld.parameters.__to}');
        expect(doc.valueColumn ?? 'value').toBe('value');
    });

    it('translates a CloudWatch metric query from a data source looked up by name', () => {
        const doc = byName('CloudWatch rule');
        const call = calls(doc.query, 'cloudwatch')[0];
        const mdq = JSON.parse(call.args[0]);
        expect(mdq.MetricStat.Metric.MetricName).toBe('UnHealthyHostCount');
        expect(mdq.MetricStat.Period).toBe(300);
        expect(call.args[3]).toBe('cloudwatch-production');
        expect(isTimeRangeAware(doc.query)).toBe(true);
        expect(doc.timeRange).toBe('30m');
    });
});
