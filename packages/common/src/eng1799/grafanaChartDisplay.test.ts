import { ChartKind } from '../types/savedCharts';
import { grafanaChartDisplay, grafanaColorToHex } from './grafanaChartDisplay';

const steps = (...values: [string, number | null][]) => ({
    mode: 'absolute',
    steps: values.map(([color, value]) => ({ color, value })),
});

describe('grafanaColorToHex', () => {
    it('reads palette names, hex and rgb colours', () => {
        expect(grafanaColorToHex('green')).toBe('#73bf69');
        expect(grafanaColorToHex('semi-dark-red')).toBe('#e02f44');
        expect(grafanaColorToHex('#ABC')).toBe('#aabbcc');
        expect(grafanaColorToHex('#11223344')).toBe('#112233');
        expect(grafanaColorToHex('rgba(255, 0, 16, 0.5)')).toBe('#ff0010');
        expect(grafanaColorToHex('text')).toBeUndefined();
        expect(grafanaColorToHex(undefined)).toBeUndefined();
    });
});

describe('grafanaChartDisplay', () => {
    it('turns stat steps into big number rules, highest first', () => {
        const result = grafanaChartDisplay(
            {
                type: 'stat',
                fieldConfig: {
                    defaults: {
                        thresholds: steps(
                            ['green', null],
                            ['orange', 1],
                            ['red', 5],
                        ),
                    },
                },
            },
            ChartKind.BIG_NUMBER,
        );
        expect(result.bigNumber?.conditionalFormatting).toEqual([
            { operator: 'greaterThanOrEqual', value: 5, color: '#f2495c' },
            { operator: 'greaterThanOrEqual', value: 1, color: '#ff9830' },
        ]);
        expect(result.warnings).toEqual([]);
    });

    it('leaves out rules with colorMode none, and warns on percentage steps or unknown colours', () => {
        const thresholds = steps(['green', null], ['red', 80]);
        expect(
            grafanaChartDisplay(
                {
                    type: 'stat',
                    options: { colorMode: 'none' },
                    fieldConfig: { defaults: { thresholds } },
                },
                ChartKind.BIG_NUMBER,
            ),
        ).toEqual({ warnings: [] });
        const percentage = grafanaChartDisplay(
            {
                type: 'stat',
                fieldConfig: {
                    defaults: {
                        thresholds: { ...thresholds, mode: 'percentage' },
                    },
                },
            },
            ChartKind.BIG_NUMBER,
        );
        expect(percentage.bigNumber).toBeUndefined();
        expect(percentage.warnings.map((w) => w.code)).toEqual([
            'thresholds-unsupported',
        ]);
        const unknown = grafanaChartDisplay(
            {
                type: 'stat',
                fieldConfig: {
                    defaults: {
                        thresholds: steps(
                            ['green', null],
                            ['text', 1],
                            ['red', 2],
                        ),
                    },
                },
            },
            ChartKind.BIG_NUMBER,
        );
        expect(unknown.bigNumber?.conditionalFormatting).toHaveLength(1);
        expect(unknown.warnings[0].message).toContain('text');
    });

    it('gives line and bar charts the percent and currency formats', () => {
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: { defaults: { unit: 'percentunit' } },
                },
                ChartKind.LINE,
            ),
        ).toEqual({
            cartesian: { yAxis: [{ format: 'percent' }] },
            warnings: [],
        });
        expect(
            grafanaChartDisplay(
                {
                    type: 'barchart',
                    fieldConfig: { defaults: { unit: 'currencyEUR' } },
                },
                ChartKind.VERTICAL_BAR,
            ).cartesian,
        ).toEqual({ yAxis: [{ format: 'eur' }] });
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: { defaults: { unit: 'none' } },
                },
                ChartKind.LINE,
            ),
        ).toEqual({ warnings: [] });
    });

    it('warns about units the chart kind cannot show', () => {
        const ms = grafanaChartDisplay(
            { type: 'timeseries', fieldConfig: { defaults: { unit: 'ms' } } },
            ChartKind.LINE,
        );
        expect(ms.cartesian).toBeUndefined();
        expect(ms.warnings).toEqual([
            {
                code: 'unit-unsupported',
                message: expect.stringContaining('ms'),
            },
        ]);
        // Grafana's percent is 0-100; Lightdash's percent format would show 90 as 9000%.
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: { defaults: { unit: 'percent' } },
                },
                ChartKind.LINE,
            ).warnings.map((w) => w.code),
        ).toEqual(['unit-unsupported']);
        expect(
            grafanaChartDisplay(
                {
                    type: 'table',
                    fieldConfig: { defaults: { unit: 'percentunit' } },
                },
                ChartKind.TABLE,
            ).warnings.map((w) => w.code),
        ).toEqual(['unit-unsupported']);
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: {
                        defaults: {},
                        overrides: [
                            {
                                matcher: { id: 'byName', options: 'p99' },
                                properties: [{ id: 'unit', value: 's' }],
                            },
                        ],
                    },
                },
                ChartKind.LINE,
            ).warnings.map((w) => w.code),
        ).toEqual(['unit-unsupported']);
    });

    it('warns about threshold lines on line and bar charts, unless they are off', () => {
        const thresholds = steps(['green', null], ['red', 0.9]);
        const drawn = (mode: string) =>
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: {
                        defaults: {
                            thresholds,
                            custom: { thresholdsStyle: { mode } },
                        },
                    },
                },
                ChartKind.LINE,
            ).warnings.map((w) => w.code);
        expect(drawn('line')).toEqual(['thresholds-unsupported']);
        expect(drawn('dashed+area')).toEqual(['thresholds-unsupported']);
        expect(drawn('off')).toEqual([]);
        expect(
            grafanaChartDisplay(
                { type: 'graph', thresholds: [{ value: 10, op: 'gt' }] },
                ChartKind.VERTICAL_BAR,
            ).warnings.map((w) => w.code),
        ).toEqual(['thresholds-unsupported']);
    });

    it('places the legend and stacks timeseries, barchart and legacy graph panels', () => {
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: {
                        defaults: { custom: { stacking: { mode: 'normal' } } },
                    },
                    options: { legend: { placement: 'right' } },
                },
                ChartKind.LINE,
            ),
        ).toEqual({
            cartesian: {
                legend: { position: 'right', align: 'start' },
                stack: 'stack',
            },
            warnings: [],
        });
        expect(
            grafanaChartDisplay(
                { type: 'barchart', options: { stacking: 'percent' } },
                ChartKind.VERTICAL_BAR,
            ).cartesian,
        ).toEqual({ stack: 'stack100' });
        expect(
            grafanaChartDisplay(
                { type: 'graph', stack: true, percentage: true },
                ChartKind.LINE,
            ).cartesian,
        ).toEqual({ stack: 'stack100' });
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    fieldConfig: {
                        defaults: { custom: { stacking: { mode: 'none' } } },
                    },
                },
                ChartKind.LINE,
            ).cartesian,
        ).toBeUndefined();
    });

    it('warns about hidden legends and per-series stacking', () => {
        const graph = grafanaChartDisplay(
            {
                type: 'graph',
                stack: true,
                legend: { show: false },
                seriesOverrides: [{ alias: 'b', stack: false }],
            },
            ChartKind.LINE,
        );
        expect(graph.cartesian).toEqual({ stack: 'stack' });
        expect(graph.warnings.map((w) => w.code)).toEqual([
            'legend-unsupported',
            'stacking-unsupported',
        ]);
        expect(
            grafanaChartDisplay(
                {
                    type: 'timeseries',
                    options: { legend: { showLegend: false } },
                    fieldConfig: {
                        overrides: [
                            {
                                properties: [
                                    {
                                        id: 'custom.stacking',
                                        value: { mode: 'normal' },
                                    },
                                ],
                            },
                        ],
                    },
                },
                ChartKind.LINE,
            ).warnings.map((w) => w.code),
        ).toEqual(['legend-unsupported', 'stacking-unsupported']);
    });

    it('warns that SQL tables and pies do not apply value mappings', () => {
        const mappings = [{ type: 'value', options: { '1': { text: 'Up' } } }];
        const table = grafanaChartDisplay(
            {
                type: 'table',
                fieldConfig: {
                    defaults: { mappings },
                    overrides: [
                        { properties: [{ id: 'mappings', value: mappings }] },
                    ],
                },
            },
            ChartKind.TABLE,
        );
        expect(table.warnings.map((w) => [w.code, w.path])).toEqual([
            ['option-dropped', 'fieldConfig.defaults.mappings'],
            ['option-dropped', 'fieldConfig.overrides.mappings'],
        ]);
        expect(table.warnings[0].message).toContain(
            'fieldConfig.defaults.mappings',
        );
        expect(
            grafanaChartDisplay(
                { type: 'table', fieldConfig: { defaults: { mappings: [] } } },
                ChartKind.TABLE,
            ).warnings,
        ).toEqual([]);
    });
});
