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

describe('Perses variables', () => {
    const withVariables = (variables: unknown[]) =>
        convertPersesDashboard(
            {
                dashboard: dashboard({
                    variables,
                    panels: {
                        q: panel('Q', 'TimeSeriesChart', {
                            queries: [
                                promQuery(
                                    'up{job="$job", env="$env", region="$region"}',
                                    'prom-prod',
                                ),
                            ],
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

    it('turns list, static and text variables into parameters', () => {
        const result = withVariables([
            {
                kind: 'ListVariable',
                spec: {
                    name: 'job',
                    display: { name: 'Job' },
                    defaultValue: 'node',
                    plugin: {
                        kind: 'PrometheusLabelValuesVariable',
                        spec: { labelName: 'job' },
                    },
                },
            },
            {
                kind: 'ListVariable',
                spec: {
                    name: 'env',
                    defaultValue: 'prod',
                    plugin: {
                        kind: 'StaticListVariable',
                        spec: {
                            values: [
                                'prod',
                                { label: 'Staging', value: 'stg' },
                            ],
                        },
                    },
                },
            },
            {
                kind: 'TextVariable',
                spec: { name: 'region', value: 'eu', constant: true },
            },
        ]);
        expect(result.parameters).toEqual({
            job: { label: 'Job', allow_custom_values: true, default: 'node' },
            env: {
                label: 'env',
                options: [
                    { label: 'prod', value: 'prod' },
                    { label: 'Staging', value: 'stg' },
                ],
                default: 'prod',
            },
        });
        expect(result.dashboard.parameters).toEqual({
            job: { parameterName: 'job', value: 'node' },
            env: { parameterName: 'env', value: 'prod' },
        });
        const { sql } = result.charts[0];
        expect(sql).toContain('${ld.parameters.job}');
        expect(sql).toContain('${ld.parameters.env}');
        // A constant text variable is inlined.
        expect(sql).toContain('region="eu"');
    });

    it('warns about multi-value and unknown variables', () => {
        const result = withVariables([
            {
                kind: 'ListVariable',
                spec: {
                    name: 'job',
                    allowMultiple: true,
                    plugin: { kind: 'PrometheusLabelValuesVariable' },
                },
            },
            { kind: 'MysteryVariable', spec: { name: 'env' } },
        ]);
        const codes = result.warnings.map((w) => w.code);
        expect(codes).toContain('variable-multi-value');
        expect(codes).toContain('variable-unsupported');
        expect(Object.keys(result.parameters)).toEqual(['job']);
    });
});

describe('Perses panel options', () => {
    const convert = (panels: Record<string, unknown>) =>
        convertPersesDashboard(
            {
                dashboard: dashboard({
                    panels,
                    layouts: [
                        {
                            kind: 'Grid',
                            spec: {
                                items: Object.keys(panels).map((id, i) =>
                                    item(id, 0, i * 8, 24, 8),
                                ),
                            },
                        },
                    ],
                }),
            },
            { spaceSlug: 'ops' },
        );
    const withSpec = (name: string, kind: string, spec: object) => ({
        kind: 'Panel',
        spec: {
            display: { name },
            plugin: { kind, spec },
            queries: [promQuery('up', 'prom')],
        },
    });

    it('carries the time series legend, stacking and y axis unit', () => {
        const { dashboard: grafana } = persesToGrafanaDashboard(
            dashboard({
                panels: {
                    cpu: withSpec('CPU', 'TimeSeriesChart', {
                        legend: { position: 'right', mode: 'table' },
                        yAxis: { format: { unit: 'percent-decimal' }, max: 1 },
                        visual: { stack: 'all', areaOpacity: 0.5 },
                    }),
                },
                layouts: [
                    {
                        kind: 'Grid',
                        spec: { items: [item('cpu', 0, 0, 24, 8)] },
                    },
                ],
            }),
        );
        expect(grafana.panels[0]).toMatchObject({
            options: {
                legend: { placement: 'right', displayMode: 'table' },
            },
            fieldConfig: {
                defaults: {
                    unit: 'percentunit',
                    max: 1,
                    custom: { stacking: { mode: 'normal' }, fillOpacity: 50 },
                },
            },
        });
        const chart = convert({
            cpu: withSpec('CPU', 'TimeSeriesChart', {
                legend: { position: 'right' },
                visual: { stack: 'all' },
            }),
        }).charts[0];
        expect(chart.config.display).toMatchObject({
            legend: { position: 'right' },
            stack: 'stack',
        });
    });

    it('turns stat thresholds into conditional formatting', () => {
        const result = convert({
            up: withSpec('Up', 'StatChart', {
                calculation: 'last-number',
                thresholds: {
                    defaultColor: '#00ff00',
                    steps: [{ value: 1, color: '#ff0000' }],
                },
            }),
        });
        expect(result.charts[0].chartKind).toBe('big_number');
        expect(result.charts[0].config.display).toMatchObject({
            conditionalFormatting: [
                { operator: 'greaterThanOrEqual', value: 1, color: '#ff0000' },
            ],
        });
    });

    it('reports options with no counterpart and unknown plugins', () => {
        const result = convert({
            table: withSpec('Table', 'Table', { density: 'compact' }),
            heat: withSpec('Heat', 'HeatmapChart', { yAxis: { min: 0 } }),
        });
        expect(
            result.warnings.map((w) => [w.code, w.panel, w.path ?? null]),
        ).toEqual(
            expect.arrayContaining([
                ['option-dropped', 'Table', 'spec.plugin.spec.density'],
                ['perses-plugin-unsupported', 'Heat', null],
            ]),
        );
        expect(result.warnings.map((w) => w.code)).not.toContain(
            'panel-type-unsupported',
        );
        expect(result.warnings.filter((w) => w.panel === 'Heat')).toHaveLength(
            1,
        );
        expect(result.todos).toEqual([
            {
                panel: 'Heat',
                text: expect.stringContaining('Perses "HeatmapChart"'),
            },
        ]);
    });
});
