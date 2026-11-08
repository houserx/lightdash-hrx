import {
    resolveGrafanaColor,
    type CartesianThresholds,
    type EChartsSeries,
    type GrafanaThresholdRange,
} from '@lightdash/common';

type ThresholdLineInput = {
    series: EChartsSeries[];
    thresholds: CartesianThresholds | undefined;
    /** The rows the chart draws, read for the y range in percentage mode */
    rows: Record<string, unknown>[];
    /** With flipped axes the value axis is x, so the lines are vertical */
    flipAxes: boolean | undefined;
    /** Whether the viewer left a series visible in the legend */
    isVisible: (serie: EChartsSeries) => boolean;
};

const drawsLines = (style: CartesianThresholds['style']) =>
    style === 'line' ||
    style === 'dashed' ||
    style === 'line+area' ||
    style === 'dashed+area';

const isDashed = (style: CartesianThresholds['style']) =>
    style === 'dashed' || style === 'dashed+area';

const valueColumn = (serie: EChartsSeries, flipAxes: boolean | undefined) =>
    flipAxes ? serie.encode?.x : serie.encode?.y;

/**
 * The y range percentage steps are read against: the min and max of the
 * values the chart's series draw on the first value axis, as Grafana reads
 * percentage thresholds against the field's min..max.
 */
const getValueRange = (
    series: EChartsSeries[],
    rows: Record<string, unknown>[],
    flipAxes: boolean | undefined,
): GrafanaThresholdRange | undefined => {
    const columns = series
        .map((serie) => valueColumn(serie, flipAxes))
        .filter((column): column is string => !!column);
    const values = rows.flatMap((row) =>
        columns
            .map((column) => Number(row[column]))
            .filter((value) => Number.isFinite(value)),
    );
    if (values.length === 0) return undefined;
    return { min: Math.min(...values), max: Math.max(...values) };
};

/**
 * Grafana's threshold lines (`thresholdsStyle` line or dashed, alone or
 * with areas): one line across the value axis at each step but the base
 * step, in the step's colour. The lines are added to the markLine of the
 * first visible series on the first value axis, so they draw once.
 */
export const applyThresholdLines = ({
    series,
    thresholds,
    rows,
    flipAxes,
    isVisible,
}: ThresholdLineInput): EChartsSeries[] => {
    if (!thresholds || !drawsLines(thresholds.style)) return series;
    const onFirstAxis = series.filter(
        (serie) =>
            serie.encode !== undefined &&
            !serie.yAxisIndex &&
            !serie.xAxisIndex,
    );
    const host =
        onFirstAxis.find((serie) => isVisible(serie)) ?? onFirstAxis[0];
    if (!host) return series;

    const range =
        thresholds.mode === 'percentage'
            ? getValueRange(onFirstAxis, rows, flipAxes)
            : undefined;
    if (thresholds.mode === 'percentage' && !range) return series;

    const axisKey = flipAxes ? 'xAxis' : 'yAxis';
    const lineType = isDashed(thresholds.style) ? 'dashed' : 'solid';
    const lines = thresholds.steps.flatMap((step, index) => {
        if (step.value === null || !Number.isFinite(step.value)) return [];
        const value = range
            ? range.min + (step.value / 100) * (range.max - range.min)
            : step.value;
        const color = resolveGrafanaColor(step.color);
        return [
            {
                uuid: `threshold-line-${index}`,
                name: `Threshold ${step.value}`,
                [axisKey]: value,
                symbol: 'none',
                silent: true,
                lineStyle: { color, type: lineType, width: 1 },
                label: { show: false },
                emphasis: { disabled: true },
            },
        ];
    });
    if (lines.length === 0) return series;

    return series.map((serie) => {
        if (serie !== host) return serie;
        const markLine = serie.markLine ?? {
            symbol: 'none',
            silent: true,
        };
        const existing = (markLine as { data?: unknown[] }).data ?? [];
        return {
            ...serie,
            markLine: { ...markLine, data: [...existing, ...lines] },
        };
    });
};
