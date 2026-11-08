import {
    CartesianSeriesType,
    type CartesianThresholds,
    type EChartsSeries,
} from '@lightdash/common';
import { describe, expect, test } from 'vitest';
import { applyThresholdAreas, applyThresholdLines } from './thresholds';

const serie = (
    y: string,
    extra: Partial<EChartsSeries> = {},
): EChartsSeries => ({
    type: CartesianSeriesType.LINE,
    name: y,
    encode: { x: 't', y, tooltip: [y], seriesName: y },
    ...extra,
});

const thresholds = (
    style: CartesianThresholds['style'],
    mode?: CartesianThresholds['mode'],
): CartesianThresholds => ({
    style,
    mode,
    steps: [
        { value: null, color: 'green' },
        { value: 80, color: 'orange' },
        { value: 90, color: '#F2495C' },
    ],
});

const rows = [
    { t: 1, a: 0, b: 10 },
    { t: 2, a: 200, b: 20 },
];

const linesOf = (series: EChartsSeries[]) =>
    series.flatMap(
        (s) => (s.markLine as { data?: Record<string, unknown>[] })?.data ?? [],
    );

const apply = (
    style: CartesianThresholds['style'],
    extra: Partial<Parameters<typeof applyThresholdLines>[0]> = {},
) =>
    applyThresholdLines({
        series: [serie('a'), serie('b')],
        thresholds: thresholds(style),
        rows,
        flipAxes: false,
        isVisible: () => true,
        ...extra,
    });

describe('applyThresholdLines', () => {
    test('adds one solid line per non-base step to the first series', () => {
        const series = apply('line');
        expect(linesOf([series[1]])).toHaveLength(0);
        const lines = linesOf(series);
        expect(lines.map((l) => l.yAxis)).toEqual([80, 90]);
        expect(lines.map((l) => l.lineStyle)).toEqual([
            { color: '#FF9830', type: 'solid', width: 1 },
            { color: '#F2495C', type: 'solid', width: 1 },
        ]);
    });

    test('dashes the lines in dashed and dashed+area styles', () => {
        for (const style of ['dashed', 'dashed+area'] as const) {
            expect(
                linesOf(apply(style)).map(
                    (l) => (l.lineStyle as { type: string }).type,
                ),
            ).toEqual(['dashed', 'dashed']);
        }
    });

    test('draws lines with line+area but none with area alone', () => {
        expect(linesOf(apply('line+area'))).toHaveLength(2);
        expect(apply('area')).toEqual([serie('a'), serie('b')]);
    });

    test('leaves the series unchanged without thresholds', () => {
        const series = [serie('a')];
        expect(
            applyThresholdLines({
                series,
                thresholds: undefined,
                rows,
                flipAxes: false,
                isVisible: () => true,
            }),
        ).toBe(series);
    });

    test('keeps existing reference lines on the host series', () => {
        const series = apply('line', {
            series: [
                serie('a', {
                    markLine: { symbol: 'none', data: [{ yAxis: '5' }] },
                }),
            ],
        });
        expect(linesOf(series).map((l) => l.yAxis)).toEqual(['5', 80, 90]);
    });

    test('hosts the lines on a visible series on the first axis', () => {
        const series = apply('line', {
            series: [serie('a'), serie('b', { yAxisIndex: 1 }), serie('c')],
            isVisible: (s) => s.name !== 'a',
        });
        expect(linesOf([series[0], series[1]])).toHaveLength(0);
        expect(linesOf([series[2]])).toHaveLength(2);
    });

    test('draws vertical lines on flipped axes', () => {
        const lines = linesOf(apply('line', { flipAxes: true }));
        expect(lines.map((l) => l.xAxis)).toEqual([80, 90]);
        expect(lines.every((l) => l.yAxis === undefined)).toBe(true);
    });

    test('reads percentage steps against the data range', () => {
        const lines = linesOf(
            apply('line', { thresholds: thresholds('line', 'percentage') }),
        );
        expect(lines.map((l) => l.yAxis)).toEqual([160, 180]);
    });
});

const areasOf = (series: EChartsSeries[]) =>
    series.flatMap(
        (s) =>
            (s.markArea as { data?: Record<string, unknown>[][] })?.data ?? [],
    );

const applyAreas = (
    style: CartesianThresholds['style'],
    extra: Partial<Parameters<typeof applyThresholdAreas>[0]> = {},
) =>
    applyThresholdAreas({
        series: [serie('a'), serie('b')],
        thresholds: thresholds(style),
        rows,
        flipAxes: false,
        isVisible: () => true,
        ...extra,
    });

describe('applyThresholdAreas', () => {
    test('shades base, middle and top bands on the first series', () => {
        const series = applyAreas('area');
        expect(areasOf([series[1]])).toHaveLength(0);
        const bands = areasOf(series);
        expect(bands.map(([from, to]) => [from.yAxis, to.yAxis])).toEqual([
            [undefined, 80],
            [80, 90],
            [90, undefined],
        ]);
        expect(
            bands.map(([from]) => (from.itemStyle as { color: string }).color),
        ).toEqual(['#73BF69', '#FF9830', '#F2495C']);
    });

    test.each(['area', 'line+area', 'dashed+area'] as const)(
        '%s draws areas',
        (style) => {
            expect(areasOf(applyAreas(style))).toHaveLength(3);
        },
    );

    test.each(['line', 'dashed'] as const)('%s draws no areas', (style) => {
        expect(areasOf(applyAreas(style))).toHaveLength(0);
    });

    test('sorts steps and uses the x axis when flipped', () => {
        const bands = areasOf(
            applyAreas('area', {
                flipAxes: true,
                thresholds: {
                    style: 'area',
                    steps: [
                        { value: 90, color: 'red' },
                        { value: null, color: 'green' },
                        { value: 80, color: 'orange' },
                    ],
                },
            }),
        );
        expect(bands.map(([from, to]) => [from.xAxis, to.xAxis])).toEqual([
            [undefined, 80],
            [80, 90],
            [90, undefined],
        ]);
    });

    test('reads percentage steps against the value range', () => {
        const bands = areasOf(
            applyAreas('area', {
                thresholds: thresholds('area', 'percentage'),
            }),
        );
        // first-axis series a and b span 0..200
        expect(bands[1][0].yAxis).toBe(160);
        expect(bands[1][1].yAxis).toBe(180);
    });

    test('keeps markArea entries the series already has', () => {
        const series = applyAreas('area', {
            series: [serie('a', { markArea: { data: [[{ xAxis: 1 }, {}]] } })],
        });
        expect(areasOf(series)).toHaveLength(4);
    });
});
