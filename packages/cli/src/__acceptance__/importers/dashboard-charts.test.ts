/* eslint-disable */
// @ts-nocheck
// imp-dashboard-chart-per-panel: every chart panel becomes one SQL chart (name, description,
// telemetry SQL) and one SQL chart tile that references it by slug.
import {
    calls,
    chartTiles,
    grafanaDashboard,
    importGrafanaDashboards,
    panel,
    promTarget,
} from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Chart Per Panel', [
            panel('timeseries', 'Requests', { x: 0, y: 0, w: 12, h: 8 }, {
                description: 'All API requests per second.',
                targets: [promTarget('sum(rate(http_requests_total[5m]))')],
            }),
            panel('timeseries', 'Requests', { x: 12, y: 0, w: 12, h: 8 }, {
                targets: [promTarget('sum(rate(http_requests_total{code=~"5.."}[5m]))')],
            }),
            panel('table', '', { x: 0, y: 8, w: 24, h: 8 }, {
                targets: [promTarget('topk(10, sum by (route) (rate(http_requests_total[5m])))')],
            }),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

describe('one SQL chart per panel', () => {
    it('writes one chart per chart panel with unique slugs', () => {
        const charts = run.charts();
        expect(charts).toHaveLength(3);
        const slugs = charts.map((c) => c.doc.slug);
        expect(new Set(slugs).size).toBe(3);
        for (const c of charts) expect(c.file).toBe(`charts/${c.doc.slug}.yml`);
    });

    it('names charts after the panel title and keeps the description', () => {
        const names = run.charts().map((c) => c.doc.name);
        expect(names.filter((n) => n === 'Requests')).toHaveLength(2);
        const described = run.charts().find((c) => c.doc.description?.includes('All API requests per second.'));
        expect(described).toBeDefined();
        // A panel without a title still gets a readable name.
        expect(names.every((n) => typeof n === 'string' && n.trim().length > 0)).toBe(true);
    });

    it('runs the translated query', () => {
        const queries = run
            .charts()
            .flatMap((c) => calls(c.doc.sql, 'promql').map((call) => call.args[0]))
            .sort();
        expect(queries).toEqual(
            [
                'sum(rate(http_requests_total[5m]))',
                'sum(rate(http_requests_total{code=~"5.."}[5m]))',
                'topk(10, sum by (route) (rate(http_requests_total[5m])))',
            ].sort(),
        );
        for (const c of run.charts()) {
            expect(c.doc.spaceSlug).toBe(run.dashboards()[0].doc.spaceSlug);
            expect(typeof c.doc.limit).toBe('number');
            expect(c.doc.config.type).toBe(c.doc.chartKind);
        }
    });

    it('places one SQL chart tile per chart, referencing it by slug', () => {
        const dashboard = run.dashboards()[0].doc;
        const tiles = chartTiles(run, dashboard);
        expect(tiles).toHaveLength(3);
        for (const { tile, chart } of tiles) {
            expect(chart).toBeDefined();
            expect(tile.properties.chartName).toBe(chart.name);
            expect(typeof tile.tileSlug).toBe('string');
        }
        expect(new Set(tiles.map((t) => t.tile.tileSlug)).size).toBe(3);
    });
});
