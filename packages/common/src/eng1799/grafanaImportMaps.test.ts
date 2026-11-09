import {
    parseGrafanaDatasourcesTf,
    readGrafanaOpsMarts,
} from './grafanaImportMaps';
import { translateGrafanaTarget } from './grafanaQuery';

describe('parseGrafanaDatasourcesTf', () => {
    it('reads each grafana_data_source resource and skips everything else', () => {
        const { datasources, skipped } = parseGrafanaDatasourcesTf(`
# A comment with "quotes" and { braces
resource "grafana_data_source" "prometheus-staging" {
  type = "prometheus"
  name = "Prometheus-Staging" // trailing comment
  uid  = "dW0QDuzIz"
  json_data_encoded = jsonencode({
    httpMethod = "POST"
    name       = "not the name"
  })
  secure_json_data_encoded = <<EOT
{"name": "also not the name"}
EOT
}

/* resource "grafana_data_source" "commented" { type = "loki" name = "x" uid = "y" } */
resource "grafana_folder" "ops" {
  title = "Ops"
  uid   = "ops"
}

resource "grafana_data_source" "sentry" {
  type = "grafana-sentry-datasource"
  name = "Sentry"
}
`);
        expect(datasources).toEqual([
            {
                type: 'prometheus',
                name: 'Prometheus-Staging',
                uid: 'dW0QDuzIz',
            },
            { type: 'grafana-sentry-datasource', name: 'Sentry', uid: '' },
        ]);
        expect(skipped).toEqual([]);
    });

    it('skips a resource whose type or name Terraform computes', () => {
        const { datasources, skipped } = parseGrafanaDatasourcesTf(`
resource "grafana_data_source" "computed" {
  type = "prometheus"
  name = "Prometheus-\${var.env}"
  uid  = "abc"
}
resource "grafana_data_source" "local" {
  type = local.type
  name = "Loki"
}
resource "grafana_data_source" "ok" {
  type = "loki"
  name = "Loki-Staging"
  uid  = "90VZkvzIz"
}
`);
        expect(datasources).toEqual([
            { type: 'loki', name: 'Loki-Staging', uid: '90VZkvzIz' },
        ]);
        expect(skipped).toEqual([
            'grafana_data_source.computed has a name Terraform computes',
            'grafana_data_source.local has a type Terraform computes',
        ]);
    });

    it('resolves a datasource without a uid by name', () => {
        const { datasources } = parseGrafanaDatasourcesTf(`
resource "grafana_data_source" "loki" {
  type = "loki"
  name = "Loki-Staging"
}
`);
        const byName = translateGrafanaTarget(
            { refId: 'A', datasource: 'Loki-Staging', expr: '{app="api"}' },
            { datasources },
        );
        expect(byName.sql).toContain("'loki-staging'");
        const emptyUid = translateGrafanaTarget(
            {
                refId: 'A',
                datasource: { type: 'loki', uid: '' },
                expr: '{app="api"}',
            },
            { datasources },
        );
        expect(emptyUid.sql).not.toContain("'loki-staging'");
    });
});

describe('readGrafanaOpsMarts', () => {
    it('reads github and sentry query type maps', () => {
        expect(
            readGrafanaOpsMarts({
                github: { Pull_Requests: ' ops_marts.github.pull_requests ' },
                sentry: null,
            }),
        ).toEqual({
            opsMarts: {
                github: { Pull_Requests: 'ops_marts.github.pull_requests' },
            },
        });
        expect(readGrafanaOpsMarts(undefined)).toEqual({ opsMarts: {} });
    });

    it('names the problem in a malformed map', () => {
        expect(readGrafanaOpsMarts(['github'])).toHaveProperty('error');
        expect(readGrafanaOpsMarts({ jira: {} })).toEqual({
            error: 'unknown key jira; only github and sentry are read',
        });
        expect(readGrafanaOpsMarts({ github: { Issues: 3 } })).toEqual({
            error: 'github.Issues must be an ops_marts.<dataset>.<table> table name, not 3',
        });
    });
});
