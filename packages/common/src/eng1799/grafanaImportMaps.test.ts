import {
    findGrafanaDashboardResource,
    parseGrafanaDashboardsTf,
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

describe('parseGrafanaDashboardsTf', () => {
    const tf = `
resource "grafana_dashboard" "root_dashboard" {
  for_each    = fileset("\${path.module}/grafana_config", "*.json")
  config_json = file("\${path.module}/grafana_config/\${each.key}")
}

resource "grafana_dashboard" "rds_dashboard" {
  for_each    = fileset("\${path.module}/grafana_config/rds", "*.json") # RDS
  folder      = grafana_folder.this["RDS"].id
}

resource "grafana_dashboard" "bcp_dr_dashboard" {
  for_each   = fileset("\${path.module}/grafana_config/bcp-dr", "{dr,bcp}-*.json")
  folder     = grafana_folder.this["BCP/DR"].uid
  depends_on = [grafana_folder.this]
}

resource "grafana_dashboard" "single" {
  config_json = file("one.json")
}

resource "grafana_dashboard" "computed" {
  for_each = fileset("\${path.module}/grafana_config/x", "*.json")
  folder   = local.folder_id
}
`;

    it('reads each fileset resource and its folder title, skipping other shapes', () => {
        const { dashboards, skipped } = parseGrafanaDashboardsTf(tf);
        expect(dashboards).toEqual([
            {
                resource: 'grafana_dashboard.root_dashboard',
                dir: 'grafana_config',
                pattern: '*.json',
                folder: undefined,
            },
            {
                resource: 'grafana_dashboard.rds_dashboard',
                dir: 'grafana_config/rds',
                pattern: '*.json',
                folder: 'RDS',
            },
            {
                resource: 'grafana_dashboard.bcp_dr_dashboard',
                dir: 'grafana_config/bcp-dr',
                pattern: '{dr,bcp}-*.json',
                folder: 'BCP/DR',
            },
        ]);
        expect(skipped).toEqual([
            'grafana_dashboard.single: it has no for_each = fileset("<dir>", "<pattern>")',
            'grafana_dashboard.computed: its folder local.folder_id is not grafana_folder.<name>["<title>"].id',
        ]);
    });

    it('finds the resource holding a dashboard file by its directory and name', () => {
        const { dashboards } = parseGrafanaDashboardsTf(tf);
        const folderOf = (file: string) =>
            findGrafanaDashboardResource(dashboards, file)?.resource;
        expect(folderOf('/a/b/grafana_config/rds/pg_cron.json')).toBe(
            'grafana_dashboard.rds_dashboard',
        );
        expect(folderOf('/a/grafana_config/golden-signals.json')).toBe(
            'grafana_dashboard.root_dashboard',
        );
        expect(
            folderOf('/a/grafana_config/bcp-dr/dr-replication-production.json'),
        ).toBe('grafana_dashboard.bcp_dr_dashboard');
        // Not matched by the pattern, a subfolder no resource names, another tree, not JSON.
        expect(folderOf('/a/grafana_config/bcp-dr/other.json')).toBeUndefined();
        expect(folderOf('/a/grafana_config/k8s/pods.json')).toBeUndefined();
        expect(folderOf('/a/elsewhere/rds/pg_cron.json')).toBeUndefined();
        expect(folderOf('/a/grafana_config/rds/README.md')).toBeUndefined();
        expect(folderOf('C:\\x\\grafana_config\\rds\\pg.json')).toBe(
            'grafana_dashboard.rds_dashboard',
        );
    });
});
