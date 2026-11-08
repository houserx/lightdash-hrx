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
