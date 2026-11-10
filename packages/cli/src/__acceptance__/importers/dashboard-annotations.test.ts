/* eslint-disable */
// @ts-nocheck
// imp-dashboard-annotations: dashboard annotations are not supported in v1; each enabled
// annotation query (other than Grafana's built-in one) is an annotations-unsupported warning.
import { BUILTIN_ANNOTATION, grafanaDashboard, importGrafanaDashboards, panel } from './support';

let withAnnotations: any;
let builtinOnly: any;
beforeAll(async () => {
    withAnnotations = await importGrafanaDashboards([
        grafanaDashboard('With Annotations', [panel('timeseries', 'Deploys', { x: 0, y: 0, w: 24, h: 8 })], {
            annotations: {
                list: [
                    BUILTIN_ANNOTATION,
                    {
                        name: 'Platform releases',
                        enable: true,
                        datasource: { type: 'grafana-github-datasource', uid: 'betb591q7ij28b' },
                        target: { queryType: 'Releases', owner: 'houserx', repository: 'platform' },
                    },
                    {
                        name: 'Deploy markers',
                        enable: true,
                        datasource: { type: 'prometheus', uid: 'tmTXpZC4k' },
                        expr: 'changes(kube_deployment_status_observed_generation[5m]) > 0',
                    },
                ],
            },
        }),
    ]);
    builtinOnly = await importGrafanaDashboards([
        grafanaDashboard('Builtin Only', [panel('timeseries', 'Quiet', { x: 0, y: 0, w: 24, h: 8 })]),
    ]);
});
afterAll(async () => {
    await withAnnotations?.cleanup();
    await builtinOnly?.cleanup();
});

describe('annotations', () => {
    it('warns once per annotation query and names it', () => {
        expect(withAnnotations.summary().warnings.byCode['annotations-unsupported']).toBe(2);
        const report = withAnnotations.report(withAnnotations.dashboards()[0].doc.slug);
        expect(report).toContain('Platform releases');
        expect(report).toContain('Deploy markers');
    });

    it('stays quiet about the built-in annotation', () => {
        expect(builtinOnly.summary().warnings.byCode['annotations-unsupported'] ?? 0).toBe(0);
    });
});
