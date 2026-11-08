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
 * The series the threshold marks hang on (the first series on the first
 * value axis the viewer left visible, else the first on that axis) and,
 * in percentage mode, the range the steps are read against. Undefined
 * when there is nothing to draw on.
 */
const getThresholdHost = ({
    series,
    thresholds,
    rows,
    flipAxes,
    isVisible,
}: ThresholdLineInput & { thresholds: CartesianThresholds }):
    | {
          host: EChartsSeries;
          toAxisValue: (stepValue: number) => number;
      }
    | undefined => {
    const onFirstAxis = series.filter(
        (serie) =>
            serie.encode !== undefined &&
            !serie.yAxisIndex &&
            !serie.xAxisIndex,
    );
    const host =
        onFirstAxis.find((serie) => isVisible(serie)) ?? onFirstAxis[0];
    if (!host) return undefined;
    if (thresholds.mode !== 'percentage') {
        return { host, toAxisValue: (stepValue) => stepValue };
    }
    const range = getValueRange(onFirstAxis, rows, flipAxes);
    if (!range) return undefined;
    return {
        host,
        toAxisValue: (stepValue) =>
            range.min + (stepValue / 100) * (range.max - range.min),
    };
};

/**
 * Grafana's threshold lines (`thresholdsStyle` line or dashed, alone or
 * with areas): one line across the value axis at each step but the base
 * step, in the step's colour. The lines are added to the markLine of the
 * first visible series on the first value axis, so they draw once.
 */
export const applyThresholdLines = (
    input: ThresholdLineInput,
): EChartsSeries[] => {
    const { series, thresholds, flipAxes } = input;
    if (!thresholds || !drawsLines(thresholds.style)) return series;
    const target = getThresholdHost({ ...input, thresholds });
    if (!target) return series;

    const axisKey = flipAxes ? 'xAxis' : 'yAxis';
    const lineType = isDashed(thresholds.style) ? 'dashed' : 'solid';
    const lines = thresholds.steps.flatMap((step, index) => {
        if (step.value === null || !Number.isFinite(step.value)) return [];
        const color = resolveGrafanaColor(step.color);
        return [
            {
                uuid: `threshold-line-${index}`,
                name: `Threshold ${step.value}`,
                [axisKey]: target.toAxisValue(step.value),
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
        if (serie !== target.host) return serie;
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

const drawsAreas = (style: CartesianThresholds['style']) =>
    style === 'area' || style === 'line+area' || style === 'dashed+area';

/** Grafana fills threshold areas with the step colour at low opacity */
const THRESHOLD_AREA_OPACITY = 0.15;

/**
 * Grafana's threshold areas (`thresholdsStyle` area, alone or with lines):
 * each step shades the band from its value up to the next step's value in
 * its colour. The base step (null) starts at the bottom of the value axis
 * and the last step runs to its top: a band edge with no axis value is
 * left out, and ECharts then stretches it to the edge of the grid. Like
 * the lines, the bands go on the markArea of one host series.
 */
export const applyThresholdAreas = (
    input: ThresholdLineInput,
): EChartsSeries[] => {
    const { series, thresholds, flipAxes } = input;
    if (!thresholds || !drawsAreas(thresholds.style)) return series;
    const target = getThresholdHost({ ...input, thresholds });
    if (!target) return series;

    const axisKey = flipAxes ? 'xAxis' : 'yAxis';
    // Base step first, then the steps in ascending order, as Grafana reads them
    const steps = thresholds.steps
        .filter((step) => step.value === null || Number.isFinite(step.value))
        .map((step) => ({
            color: resolveGrafanaColor(step.color),
            from:
                step.value === null
                    ? undefined
                    : target.toAxisValue(step.value),
        }))
        .sort(
            (a, b) =>
                (a.from ?? Number.NEGATIVE_INFINITY) -
                (b.from ?? Number.NEGATIVE_INFINITY),
        );
    const edge = (value: number | undefined) =>
        value === undefined ? {} : { [axisKey]: value };
    const bands = steps.flatMap((step, index) => {
        const to = steps[index + 1]?.from;
        if (step.from !== undefined && to !== undefined && to <= step.from) {
            return [];
        }
        return [
            [
                {
                    name: `Threshold ${step.from ?? 'base'}`,
                    ...edge(step.from),
                    itemStyle: {
                        color: step.color,
                        opacity: THRESHOLD_AREA_OPACITY,
                    },
                },
                edge(to),
            ],
        ];
    });
    if (bands.length === 0) return series;

    return series.map((serie) => {
        if (serie !== target.host) return serie;
        const markArea = serie.markArea ?? { silent: true };
        const existing = (markArea as { data?: unknown[] }).data ?? [];
        return {
            ...serie,
            markArea: { ...markArea, data: [...existing, ...bands] },
        };
    });
};
