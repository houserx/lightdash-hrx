import type { GaugeSection } from '../types/savedCharts';

/**
 * Grafana threshold steps, as stored in a panel's
 * `fieldConfig.defaults.thresholds`. The first step is the base step and
 * has `value: null` (Grafana's -Infinity); each later step starts at its
 * value. In `percentage` mode step values are percentages of the min..max
 * range instead of absolute values.
 */
export type GrafanaThresholdStep = {
    value: number | null;
    color: string;
};

export type GrafanaThresholds = {
    mode: 'absolute' | 'percentage';
    steps: GrafanaThresholdStep[];
};

/**
 * How a cartesian chart draws its thresholds: a solid or dashed horizontal
 * line at each step, shaded bands between steps, or lines plus bands.
 */
export type CartesianThresholdsStyle =
    | 'line'
    | 'dashed'
    | 'area'
    | 'line+area'
    | 'dashed+area';

/**
 * Grafana-style thresholds on a cartesian chart (Grafana's time series
 * `thresholdsStyle` plus its threshold steps). `mode` defaults to
 * `absolute`.
 */
export type CartesianThresholds = {
    /** Step values are absolute or percentages of the y range */
    mode?: GrafanaThresholds['mode'];
    /** Threshold steps; the base step has `value: null` */
    steps: GrafanaThresholdStep[];
    /** How the thresholds are drawn */
    style: CartesianThresholdsStyle;
};

export type GrafanaThresholdRange = {
    min: number;
    max: number;
};

/** Grafana's default range when a panel sets no min/max. */
const DEFAULT_RANGE: GrafanaThresholdRange = { min: 0, max: 100 };

/** Grafana's "base" fallback when a panel has no threshold steps. */
const FALLBACK_COLOR = '#73BF69';

/**
 * Grafana's named palette colours (the six hues and their shades). Grafana
 * stores a picked palette colour by name, e.g. `green` or `semi-dark-red`.
 */
const GRAFANA_HUES: Record<string, [string, string, string, string, string]> = {
    // super-light, light, base, semi-dark, dark
    red: ['#FFA6B0', '#FF7383', '#F2495C', '#E02F44', '#C4162A'],
    orange: ['#FFCB7D', '#FFB357', '#FF9830', '#FF780A', '#FA6400'],
    yellow: ['#FFF899', '#FFEE52', '#FADE2A', '#F2CC0C', '#E0B400'],
    green: ['#C8F2C2', '#96D98D', '#73BF69', '#56A64B', '#37872D'],
    blue: ['#C0D8FF', '#8AB8FF', '#5794F2', '#3274D9', '#1F60C4'],
    purple: ['#DEB6F2', '#CA95E5', '#B877D9', '#A352CC', '#8F3BB8'],
};

const SHADE_PREFIXES = [
    'super-light-',
    'light-',
    '',
    'semi-dark-',
    'dark-',
] as const;

export const GRAFANA_NAMED_COLORS: Readonly<Record<string, string>> =
    Object.fromEntries(
        Object.entries(GRAFANA_HUES).flatMap(([hue, shades]) =>
            shades.map((hex, i) => [`${SHADE_PREFIXES[i]}${hue}`, hex]),
        ),
    );

/**
 * Resolves a Grafana colour to a CSS colour: palette names become their
 * hex value, anything else (hex, rgb(), CSS names) is returned unchanged.
 */
export const resolveGrafanaColor = (color: string): string =>
    GRAFANA_NAMED_COLORS[color.trim().toLowerCase()] ?? color;

const sortedSteps = (thresholds: GrafanaThresholds): GrafanaThresholdStep[] =>
    [...thresholds.steps].sort(
        (a, b) => (a.value ?? -Infinity) - (b.value ?? -Infinity),
    );

/** Converts a step value to an absolute value in the given range. */
const stepToAbsolute = (
    stepValue: number,
    thresholds: GrafanaThresholds,
    range: GrafanaThresholdRange,
): number =>
    thresholds.mode === 'percentage'
        ? range.min + (stepValue / 100) * (range.max - range.min)
        : stepValue;

/**
 * Returns the colour of the highest step whose value is at or below the
 * given value, as Grafana's stat and gauge panels do. Percentage steps are
 * read against `range` (Grafana's default 0..100 when it is not given).
 */
export const getThresholdColor = (
    value: number,
    thresholds: GrafanaThresholds,
    range: GrafanaThresholdRange = DEFAULT_RANGE,
): string => {
    const steps = sortedSteps(thresholds);
    if (steps.length === 0) return FALLBACK_COLOR;
    const match = steps.reduce<GrafanaThresholdStep>(
        (current, step) =>
            step.value === null ||
            stepToAbsolute(step.value, thresholds, range) <= value
                ? step
                : current,
        steps[0],
    );
    return resolveGrafanaColor(match.color);
};

/**
 * Converts Grafana threshold steps to the built-in gauge's sections: one
 * section per step, from the step's start to the next step's start,
 * clamped to min..max. Steps that fall wholly outside the range are
 * dropped.
 */
export const grafanaThresholdsToGaugeSections = (
    thresholds: GrafanaThresholds,
    range: GrafanaThresholdRange = DEFAULT_RANGE,
): GaugeSection[] => {
    const steps = sortedSteps(thresholds);
    const clamp = (n: number) => Math.min(range.max, Math.max(range.min, n));
    const starts = steps.map((step) =>
        step.value === null
            ? range.min
            : clamp(stepToAbsolute(step.value, thresholds, range)),
    );
    return steps
        .map((step, i) => ({
            min: starts[i],
            max: i + 1 < steps.length ? starts[i + 1] : range.max,
            color: resolveGrafanaColor(step.color),
        }))
        .filter((section) => section.max > section.min);
};
