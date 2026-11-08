import type {
    GrafanaThresholds,
    GrafanaThresholdRange,
} from '../../../../packages/common/src/eng1799/grafanaThresholds';

/**
 * The bar gauge's model (Grafana `bargauge`): one bar per row, in row
 * order, filled by the row's value between the panel's min and max.
 */

export const ORIENTATIONS = ['horizontal', 'vertical'] as const;

export type Orientation = (typeof ORIENTATIONS)[number];

/** The `orientation` option; anything unknown (Grafana's auto) is horizontal. */
export const orientationOption = (raw: unknown): Orientation =>
    ORIENTATIONS.find((o) => o === raw) ?? 'horizontal';

export const DISPLAY_MODES = ['gradient', 'basic'] as const;

export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** The `displayMode` option; anything unknown is Grafana's default, gradient. */
export const displayModeOption = (raw: unknown): DisplayMode =>
    DISPLAY_MODES.find((m) => m === raw) ?? 'gradient';

export type GaugeBar = {
    name: string;
    value: number | null;
    /** Share of the min..max range the bar fills, clamped to 0..1. */
    fill: number;
};

/**
 * The share of `min..max` that `value` fills, clamped to 0..1 (a value
 * below min is an empty bar, above max a full one, as Grafana draws them).
 * A missing value is empty; an empty range (max <= min) fills a bar whose
 * value reaches max and leaves the others empty.
 */
export const fillOf = (
    value: number | null,
    min: number,
    max: number,
): number => {
    if (value === null) return 0;
    if (max <= min) return value >= max ? 1 : 0;
    const share = (value - min) / (max - min);
    return Math.min(1, Math.max(0, share));
};

/** One bar per row, in row order. */
export const buildBars = (
    rows: readonly { name: string; value: number | null }[],
    min: number,
    max: number,
): GaugeBar[] =>
    rows.map(({ name, value }) => ({
        name,
        value,
        fill: fillOf(value, min, max),
    }));

export type GradientStop = {
    color: string;
    /** Position along the bar, 0 (the min end) to 1 (the value end). */
    offset: number;
};

/** A 6-digit hex colour at the given alpha (other colours unchanged). */
export const fadeColor = (color: string, alpha: number): string => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
    const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    return `${color}${byte.toString(16).padStart(2, '0').toUpperCase()}`;
};

/**
 * The colour stops of a gradient bar, from its min end to its value end,
 * as Grafana's gradient mode draws them: the threshold colour at min, each
 * threshold step that starts inside the bar at its place along the bar,
 * and the value's own colour at the end (the bar ends at max). A bar that crosses no step fades
 * in from a translucent shade of its colour to the full colour.
 * `colorAt` is the threshold colour lookup (shared/thresholds).
 */
export const gradientStops = (
    value: number,
    thresholds: GrafanaThresholds | undefined,
    range: GrafanaThresholdRange,
    colorAt: (value: number) => string,
): GradientStop[] => {
    const { min, max } = range;
    const end = colorAt(value);
    // The bar stops at max, so stops are placed along min..min(value, max).
    const top = Math.min(value, max);
    const span = top - min;
    const stops: GradientStop[] = [];
    if (span > 0) {
        stops.push({ color: colorAt(min), offset: 0 });
        const steps = (thresholds?.steps ?? [])
            .map((step) =>
                step.value === null
                    ? null
                    : thresholds?.mode === 'percentage'
                      ? min + (step.value / 100) * (max - min)
                      : step.value,
            )
            .filter((at): at is number => at !== null && at > min && at < top)
            .sort((a, b) => a - b);
        for (const at of steps) {
            stops.push({ color: colorAt(at), offset: (at - min) / span });
        }
    }
    stops.push({ color: end, offset: 1 });
    if (stops.every((stop) => stop.color === end)) {
        return [
            { color: fadeColor(end, 0.4), offset: 0 },
            { color: end, offset: 1 },
        ];
    }
    return stops;
};

/** A CSS `linear-gradient` through the stops, along the bar's direction. */
export const linearGradientCss = (
    stops: readonly GradientStop[],
    direction: 'to right' | 'to top',
): string =>
    `linear-gradient(${direction}, ${stops
        .map(
            (stop) => `${stop.color} ${Math.round(stop.offset * 10000) / 100}%`,
        )
        .join(', ')})`;
