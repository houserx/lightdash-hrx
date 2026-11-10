/* eslint-disable */
// @ts-nocheck
// imp-dashboard-time-range: the Grafana time range and refresh become the Dashboard Time Range
// (as-code `timeRange`), and every telemetry tile's SQL reads the reserved time parameters.
import {
    expectValidDashboard,
    grafanaDashboard,
    importGrafanaDashboards,
    isTimeRangeAware,
    LOKI_DS,
    panel,
} from './support';

const panels = () => [
    panel('timeseries', 'Prometheus', { x: 0, y: 0, w: 12, h: 8 }),
    panel('logs', 'Logs', { x: 12, y: 0, w: 12, h: 8 }, {
        datasource: LOKI_DS,
        targets: [{ refId: 'A', datasource: LOKI_DS, expr: '{app="api"}' }],
    }),
];

let runs: any = {};
beforeAll(async () => {
    runs.relative = await importGrafanaDashboards([
        grafanaDashboard('Relative Range', panels(), { time: { from: 'now-24h', to: 'now' }, refresh: '1m' }),
    ]);
    runs.absolute = await importGrafanaDashboards([
        grafanaDashboard('Absolute Range', panels(), {
            time: { from: '2025-06-16T19:36:59.653Z', to: '2025-06-17T07:00:00.000Z' },
            refresh: false,
        }),
    ]);
    runs.oddRefresh = await importGrafanaDashboards([
        grafanaDashboard('Fast Refresh', panels(), { time: { from: 'now-30m', to: 'now' }, refresh: '5s' }),
    ]);
});
afterAll(async () => {
    for (const r of Object.values(runs)) await r?.cleanup();
});

describe('Dashboard Time Range', () => {
    it('keeps a relative range and the refresh interval', () => {
        const dashboard = runs.relative.dashboards()[0].doc;
        expectValidDashboard(dashboard);
        expect(dashboard.timeRange).toMatchObject({ from: 'now-24h', to: 'now', refreshInterval: '1m' });
    });

    it('keeps an absolute range as ISO timestamps, with no refresh', () => {
        const dashboard = runs.absolute.dashboards()[0].doc;
        expectValidDashboard(dashboard);
        expect(new Date(dashboard.timeRange.from).toISOString()).toBe('2025-06-16T19:36:59.653Z');
        expect(new Date(dashboard.timeRange.to).toISOString()).toBe('2025-06-17T07:00:00.000Z');
        expect(dashboard.timeRange.refreshInterval ?? null).toBeNull();
    });

    it('moves a refresh Lightdash does not offer to the nearest one, with a warning', () => {
        const dashboard = runs.oddRefresh.dashboards()[0].doc;
        expectValidDashboard(dashboard);
        expect(dashboard.timeRange.refreshInterval).toBe('10s');
        expect(runs.oddRefresh.summary().warnings.byCode['refresh-adjusted']).toBe(1);
    });

    it('makes every telemetry tile time-range-aware', () => {
        for (const run of Object.values(runs)) {
            const charts = run.charts();
            expect(charts.length).toBe(2);
            for (const c of charts) expect(isTimeRangeAware(c.doc.sql)).toBe(true);
        }
    });
});
