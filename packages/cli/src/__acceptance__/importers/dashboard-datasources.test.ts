/* eslint-disable */
// @ts-nocheck
// imp-dashboard-datasources: --datasources <grafana_data_sources.tf> resolves panel datasource
// uids to Telemetry Source names in the chart SQL; --ops-marts <file.yml> maps GitHub and
// Sentry query types to Ops Mart tables.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    DATASOURCES_TF,
    calls,
    grafanaDashboard,
    importGrafanaDashboards,
    panel,
    tempDir,
} from './support';

const dash = grafanaDashboard('Datasource Map', [
    panel('timeseries', 'Staging prom', { x: 0, y: 0, w: 12, h: 8 }, {
        datasource: { type: 'prometheus', uid: 'dW0QDuzIz' },
        targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'dW0QDuzIz' }, expr: 'up' }],
    }),
    panel('table', 'Pull requests', { x: 12, y: 0, w: 12, h: 8 }, {
        datasource: { type: 'grafana-github-datasource', uid: 'betb591q7ij28b' },
        targets: [{ refId: 'A', datasource: { type: 'grafana-github-datasource', uid: 'betb591q7ij28b' }, queryType: 'Pull_Requests', owner: 'houserx', repository: 'platform' }],
    }),
]);

let plain: any;
let mapped: any;
let marts: any;
beforeAll(async () => {
    marts = await tempDir();
    const martsFile = path.join(marts.dir, 'ops-marts.yml');
    await writeFile(martsFile, 'github:\n  Pull_Requests: ops_marts.github.pull_requests\n');
    plain = await importGrafanaDashboards([dash]);
    mapped = await importGrafanaDashboards([dash], ['--datasources', DATASOURCES_TF, '--ops-marts', martsFile]);
});
afterAll(async () => {
    await plain?.cleanup();
    await mapped?.cleanup();
    await marts?.cleanup();
});

describe('datasource and Ops Mart maps', () => {
    it('names the Telemetry Source from grafana_data_sources.tf', () => {
        const chart = mapped.charts().find((c) => c.doc.name === 'Staging prom').doc;
        expect(calls(chart.sql, 'promql')[0].args[4]).toBe('prometheus-staging');
    });

    it('uses the engine default source, with a warning, without the map', () => {
        const chart = plain.charts().find((c) => c.doc.name === 'Staging prom').doc;
        expect(calls(chart.sql, 'promql')[0].args).toHaveLength(4);
        expect(plain.summary().warnings.byCode['datasource-unresolved']).toBeGreaterThanOrEqual(1);
    });

    it('reads a mapped Ops Mart instead of a TODO', () => {
        expect(plain.summary().todos).toBe(1);
        expect(mapped.summary().todos).toBe(0);
        const chart = mapped.charts().find((c) => c.doc.name === 'Pull requests').doc;
        expect(chart.sql).toMatch(/ops_marts\.github\.pull_requests/);
    });
});
