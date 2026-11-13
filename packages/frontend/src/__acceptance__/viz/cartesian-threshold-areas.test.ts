/**
 * Feature viz-cartesian-threshold-areas: in "area" style (and the
 * "+area" styles) a cartesian chart shades each threshold band in the
 * step's colour, from the step value up to the next step.
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
]);

const option = (style: string) => {
    const rendered = renderChart({ chartConfig: chart(style) }, data);
    expect(rendered.kind).toBe('echarts');
    return (rendered as { option: { series: unknown[] } }).option.series as {
        markArea?: { data?: unknown[][] };
        markLine?: { data?: unknown[] };
    }[];
};

const bands = (style: string) =>
    option(style).flatMap((s) => s.markArea?.data ?? []);

const bandStartingAt = (all: unknown[][], value: number) =>
    all.filter((pair) => JSON.stringify(pair[0]).includes(`"yAxis":${value}`));

describe('cartesian threshold areas', () => {
    it('shades the band from each step to the next in its colour', () => {
        const all = bands('area');
        const from80 = bandStartingAt(all, 80);
        expect(from80).toHaveLength(1);
        expect(JSON.stringify(from80[0])).toContain('"yAxis":90');
        expect(JSON.stringify(from80[0]).toUpperCase()).toContain('#FF9830');
        const from90 = bandStartingAt(all, 90);
        expect(from90).toHaveLength(1);
        expect(JSON.stringify(from90[0]).toUpperCase()).toContain('#F2495C');
    });

    it('shades the base band below the first step', () => {
        const all = bands('area');
        const base = all.filter((pair) =>
            JSON.stringify(pair).toUpperCase().includes('#73BF69'),
        );
        expect(base).toHaveLength(1);
        expect(JSON.stringify(base[0][1])).toContain('"yAxis":80');
    });

    it('draws areas and lines together in line+area style', () => {
        const series = option('line+area');
        expect(bandStartingAt(series.flatMap((s) => s.markArea?.data ?? []), 80)).toHaveLength(1);
        expect(
            series
                .flatMap((s) => s.markLine?.data ?? [])
                .filter((e) => JSON.stringify(e).includes('"yAxis":80')),
        ).toHaveLength(1);
    });

    it('draws no areas in line style', () => {
        expect(bands('line')).toHaveLength(0);
    });
});
