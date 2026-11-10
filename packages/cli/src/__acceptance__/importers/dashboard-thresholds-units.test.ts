/* eslint-disable */
// @ts-nocheck
// imp-dashboard-thresholds-units: thresholds and units map as far as the SQL chart kind
// supports: a stat panel's threshold steps become big number conditional formatting, a
// percentunit (0-1) unit becomes the percent format, and what the chart kind can't show is a warning.
import { chartTiles, grafanaDashboard, importGrafanaDashboards, panel } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Thresholds And Units', [
            panel('stat', 'Error ratio', { x: 0, y: 0, w: 8, h: 6 }, {
                fieldConfig: {
                    defaults: {
                        unit: 'percent',
                        thresholds: {
                            mode: 'absolute',
                            steps: [
                                { color: 'green', value: null },
                                { color: 'orange', value: 1 },
                                { color: 'red', value: 5 },
                            ],
                        },
                    },
                    overrides: [],
                },
                options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value' },
            }),
            panel('timeseries', 'CPU', { x: 8, y: 0, w: 16, h: 6 }, {
                fieldConfig: {
                    defaults: {
                        unit: 'percentunit',
                        custom: { thresholdsStyle: { mode: 'line' } },
                        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 0.9 }] },
                    },
                    overrides: [],
                },
            }),
            panel('timeseries', 'Latency', { x: 0, y: 6, w: 24, h: 6 }, {
                fieldConfig: { defaults: { unit: 'ms' }, overrides: [] },
            }),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

const chart = (title) =>
    chartTiles(run, run.dashboards()[0].doc).find((t) => t.tile.properties.title === title).chart;

describe('thresholds and units', () => {
    it('turns stat threshold steps into big number conditional formatting', () => {
        const stat = chart('Error ratio');
        expect(stat.chartKind).toBe('big_number');
        const rules = stat.config.display.conditionalFormatting;
        expect(rules).toHaveLength(2);
        const byValue = Object.fromEntries(rules.map((r) => [r.value, r]));
        expect(byValue[1].operator).toMatch(/greaterThan/);
        expect(byValue[5].operator).toMatch(/greaterThan/);
        expect(byValue[5].color.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
        expect(byValue[5].color).not.toBe(byValue[1].color);
    });

    it('formats a 0-1 percentunit series with the percent format', () => {
        // Lightdash's percent format shows 0.9 as 90%, which is Grafana's percentunit.
        expect(JSON.stringify(chart('CPU').config.display)).toContain('"percent"');
    });

    it('warns about units and threshold lines the chart kind cannot show', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        // ms has no SQL chart format, and line charts have no threshold lines.
        const latencyLines = report.split('\n').filter((l) => l.includes('Latency'));
        expect(latencyLines.join('\n')).toContain('ms');
        const cpuLines = report.split('\n').filter((l) => l.includes('CPU'));
        expect(cpuLines.join('\n').toLowerCase()).toContain('threshold');
    });
});
