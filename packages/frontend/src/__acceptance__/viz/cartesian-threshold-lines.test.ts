/**
 * Feature viz-cartesian-threshold-lines: a cartesian chart with thresholds
 * in "line" or "dashed" style draws a horizontal line at each step (not the
 * base step) in the step's colour.
 */
import { ChartType, type ChartConfig } from '@lightdash/common';
import { renderChart } from '@lightdash/visualization';
import { describe, expect, it } from 'vitest';
import { metricData } from './fixtures';

const chart = (style: string): ChartConfig =>
    ({
        type: ChartType.CARTESIAN,
        config: {
            layout: { xField: 'm_time', yField: ['m_value'] },
            eChartsConfig: {
                series: [
                    {
                        type: 'line',
                        encode: {
                            xRef: { field: 'm_time' },
                            yRef: { field: 'm_value' },
                        },
                    },
                ],
            },
            thresholds: {
                mode: 'absolute',
                style,
                steps: [
                    { value: null, color: '#73BF69' },
                    { value: 80, color: '#FF9830' },
                    { value: 90, color: '#F2495C' },
                ],
            },
        },
    }) as unknown as ChartConfig;

const data = metricData([
    [0, 50],
    [1, 85],
    [2, 95],
    [3, 60],
]);

const markLines = (style: string) => {
    const rendered = renderChart({ chartConfig: chart(style) }, data);
    expect(rendered.kind).toBe('echarts');
    const option = (rendered as { option: { series: unknown[] } }).option;
    return (option.series as { markLine?: { data?: unknown[] } }[]).flatMap(
        (s) => s.markLine?.data ?? [],
    );
};

const find = (entries: unknown[], value: number) =>
    entries.filter((e) => JSON.stringify(e).includes(`"yAxis":${value}`));

describe('cartesian threshold lines', () => {
    it('control: the chart renders as ECharts without thresholds lines today', () => {
        const rendered = renderChart(
            {
                chartConfig: {
                    type: ChartType.CARTESIAN,
                    config: {
                        layout: { xField: 'm_time', yField: ['m_value'] },
                        eChartsConfig: {},
                    },
                },
            },
            data,
        );
        expect(rendered.kind).toBe('echarts');
    });

    it('draws a line per step in its colour', () => {
        const entries = markLines('line');
        const at80 = find(entries, 80);
        const at90 = find(entries, 90);
        expect(at80).toHaveLength(1);
        expect(at90).toHaveLength(1);
        expect(JSON.stringify(at80[0]).toUpperCase()).toContain('#FF9830');
        expect(JSON.stringify(at90[0]).toUpperCase()).toContain('#F2495C');
    });

    it('draws no line for the base step', () => {
        const entries = markLines('line');
        expect(
            entries.filter((e) =>
                JSON.stringify(e).toUpperCase().includes('#73BF69'),
            ),
        ).toHaveLength(0);
    });

    it('dashes the lines in dashed style', () => {
        const at80 = find(markLines('dashed'), 80);
        expect(at80).toHaveLength(1);
        expect(JSON.stringify(at80[0])).toContain('"dashed"');
    });

    it('draws no lines in area style', () => {
        expect(find(markLines('area'), 80)).toHaveLength(0);
    });
});
