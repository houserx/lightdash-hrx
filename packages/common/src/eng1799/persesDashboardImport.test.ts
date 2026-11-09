import {
    convertPersesDashboard,
    persesToGrafanaDashboard,
    readPersesDashboard,
    type PersesDashboard,
} from './persesDashboardImport';

const promQuery = (query: string, datasource?: string) => ({
    kind: 'TimeSeriesQuery',
    spec: {
        plugin: {
            kind: 'PrometheusTimeSeriesQuery',
            spec: {
                query,
                ...(datasource === undefined
                    ? {}
                    : {
                          datasource: {
                              kind: 'PrometheusDatasource',
                              name: datasource,
                          },
                      }),
            },
        },
    },
});

const panel = (name: string, kind: string, extra: object = {}) => ({
    kind: 'Panel',
    spec: { display: { name }, plugin: { kind, spec: {} }, ...extra },
});

const item = (
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
) => ({
    x,
    y,
    width,
    height,
    content: { $ref: `#/spec/panels/${id}` },
});

const dashboard = (
    spec: Partial<PersesDashboard['spec']>,
): PersesDashboard => ({
    kind: 'Dashboard',
    metadata: { name: 'test', project: 'ops' },
    spec: { display: { name: 'Test' }, panels: {}, ...spec },
});

describe('readPersesDashboard', () => {
    it('accepts a Perses dashboard', () => {
        expect('dashboard' in readPersesDashboard(dashboard({}))).toBe(true);
    });

    it.each([
        [{ title: 'Grafana', panels: [] }, 'no `kind: Dashboard`'],
        [{ kind: 'Datasource', spec: {} }, 'kind is "Datasource"'],
        [{ kind: 'Dashboard' }, 'no spec'],
        [{ kind: 'Dashboard', spec: {} }, 'no spec.panels'],
        [
            { kind: 'Dashboard', spec: { panels: {} } },
            'neither spec.display.name',
        ],
        [[], 'expected a JSON or YAML object'],
    ])('rejects %j', (doc, reason) => {
        const result = readPersesDashboard(doc);
        expect('error' in result && result.error).toContain(reason);
    });
});

describe('persesToGrafanaDashboard', () => {
    it('stacks grids, turning titled ones into rows', () => {
        const { dashboard: grafana, warnings } = persesToGrafanaDashboard(
            dashboard({
                panels: {
                    a: panel('A', 'TimeSeriesChart'),
                    b: panel('B', 'Table'),
                    c: panel('C', 'StatChart'),
                },
                layouts: [
                    { kind: 'Grid', spec: { items: [item('a', 0, 0, 24, 8)] } },
                    {
                        kind: 'Grid',
                        spec: {
                            display: {
                                title: 'More',
                                collapse: { open: false },
                            },
                            items: [
                                item('b', 0, 0, 12, 6),
                                item('c', 12, 0, 12, 6),
                            ],
                        },
                    },
                ],
            }),
        );
        expect(warnings).toEqual([]);
        expect(grafana.panels.map((p) => [p.type, p.title, p.gridPos])).toEqual(
            [
                ['timeseries', 'A', { x: 0, y: 0, w: 24, h: 8 }],
                ['row', 'More', { x: 0, y: 8, w: 24, h: 1 }],
            ],
        );
        expect(grafana.panels[1].collapsed).toBe(true);
        expect(
            grafana.panels[1].panels?.map((p) => [p.type, p.gridPos]),
        ).toEqual([
            ['table', { x: 0, y: 9, w: 12, h: 6 }],
            ['stat', { x: 12, y: 9, w: 12, h: 6 }],
        ]);
    });

    it('maps queries, markdown, time range and unplaced panels', () => {
        const {
            dashboard: grafana,
            datasources,
            warnings,
        } = persesToGrafanaDashboard(
            dashboard({
                duration: '1h',
                refreshInterval: '30s',
                panels: {
                    q: panel('Q', 'TimeSeriesChart', {
                        queries: [
                            promQuery('up', 'prom-prod'),
                            promQuery('down'),
                        ],
                    }),
                    md: {
                        kind: 'Panel',
                        spec: {
                            display: { name: 'Notes' },
                            plugin: {
                                kind: 'Markdown',
                                spec: { text: '# Hi' },
                            },
                        },
                    },
                    lost: panel('Lost', 'Table'),
                },
                layouts: [
                    {
                        kind: 'Grid',
                        spec: {
                            items: [
                                item('q', 0, 0, 12, 8),
                                item('md', 12, 0, 12, 8),
                            ],
                        },
                    },
                ],
            }),
        );
        expect(grafana.time).toEqual({ from: 'now-1h', to: 'now' });
        expect(grafana.refresh).toBe('30s');
        expect(grafana.panels[0].targets).toEqual([
            {
                refId: 'A',
                datasource: { type: 'prometheus', uid: 'prom-prod' },
                expr: 'up',
                range: true,
            },
            {
                refId: 'B',
                datasource: { type: 'prometheus' },
                expr: 'down',
                range: true,
            },
        ]);
        expect(datasources).toEqual([
            { uid: 'prom-prod', name: 'prom-prod', type: 'prometheus' },
        ]);
        expect(grafana.panels[1]).toMatchObject({
            type: 'text',
            options: { mode: 'markdown', content: '# Hi' },
        });
        expect(warnings.map((w) => [w.code, w.panel])).toEqual([
            ['panel-dropped', 'Lost'],
        ]);
    });
});

describe('convertPersesDashboard', () => {
    it('resolves a named Prometheus datasource to its Telemetry Source', () => {
        const result = convertPersesDashboard(
            {
                dashboard: dashboard({
                    panels: {
                        q: panel('Q', 'TimeSeriesChart', {
                            queries: [promQuery('up', 'prom-prod')],
                        }),
                    },
                    layouts: [
                        {
                            kind: 'Grid',
                            spec: { items: [item('q', 0, 0, 24, 8)] },
                        },
                    ],
                }),
            },
            { spaceSlug: 'ops' },
        );
        expect(result.dashboard.name).toBe('Test');
        expect(result.charts).toHaveLength(1);
        expect(result.charts[0].sql).toContain("'prom-prod'");
        expect(result.warnings.map((w) => w.code)).not.toContain(
            'datasource-unresolved',
        );
    });
});
