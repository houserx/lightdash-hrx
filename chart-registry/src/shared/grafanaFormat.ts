/**
 * Formats a number the way a Grafana panel shows it for a unit
 * (`fieldConfig.defaults.unit`) and decimals (`fieldConfig.defaults.decimals`).
 *
 * Unlike the Lightdash number formats in @lightdash/common's grafanaUnits.ts
 * (fixed suffixes), registry entries draw their own text, so they scale the
 * value the way Grafana does: bytes to KiB/MiB/..., time to the largest unit
 * that keeps the value at least 1, and `short` to K/Mil/Bil/Tri. Standalone
 * (no @lightdash/common runtime import) to keep the entry bundle small.
 */

export type FormattedValue = { prefix: string; text: string; suffix: string };

/** Decimals Grafana would pick on its own: up to 2, ~3 significant below 1. */
const autoDecimals = (value: number): number => {
    const abs = Math.abs(value);
    if (abs === 0 || Number.isInteger(value)) return 0;
    if (abs >= 1) return 2;
    return Math.min(Math.max(2, 2 - Math.floor(Math.log10(abs))), 6);
};

/**
 * `value` rounded to `decimals`, or to automatic decimals with trailing
 * zeros dropped when `decimals` is null.
 */
export const toFixed = (value: number, decimals: number | null): string => {
    const text =
        decimals === null
            ? Number(value.toFixed(autoDecimals(value))).toString()
            : value.toFixed(decimals);
    // -0.0 reads as 0.0
    return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
};

/** Scales by `factor` through `units` until the value is below one step. */
const scaled = (
    value: number,
    decimals: number | null,
    factor: number,
    units: string[],
    start = 0,
): FormattedValue => {
    let index = start;
    let scaledValue = value;
    while (Math.abs(scaledValue) >= factor && index < units.length - 1) {
        scaledValue /= factor;
        index += 1;
    }
    return {
        prefix: '',
        text: toFixed(scaledValue, decimals),
        suffix: ` ${units[index]}`,
    };
};

const IEC_BYTES = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
const SI_BYTES = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'];
const SI_BITS = ['b', 'kb', 'Mb', 'Gb', 'Tb', 'Pb', 'Eb'];
const SHORT = ['', 'K', 'Mil', 'Bil', 'Tri', 'Quadr', 'Quint'];

// Time units in milliseconds, smallest first, with Grafana's unit text.
const TIME_UNITS: [string, number, string][] = [
    ['ns', 1e-6, 'ns'],
    ['µs', 1e-3, 'µs'],
    ['us', 1e-3, 'µs'],
    ['ms', 1, 'ms'],
    ['s', 1000, 's'],
    ['m', 60_000, 'min'],
    ['h', 3_600_000, 'hour'],
    ['d', 86_400_000, 'day'],
];
const TIME_LADDER: [number, string, number][] = [
    // [unit size in ms, text, value in this unit at which to step up]
    [1e-6, 'ns', 1000],
    [1e-3, 'µs', 1000],
    [1, 'ms', 1000],
    [1000, 's', 60],
    [60_000, 'min', 60],
    [3_600_000, 'hour', 24],
    [86_400_000, 'day', 365],
    [31_536_000_000, 'year', Infinity],
];

const time = (
    value: number,
    unitMs: number,
    decimals: number | null,
): FormattedValue => {
    // Start at the panel's own unit and step up while the value is large.
    let index = TIME_LADDER.findIndex(([size]) => size === unitMs);
    let scaledValue = value;
    while (
        index < TIME_LADDER.length - 1 &&
        Math.abs(scaledValue) >= TIME_LADDER[index][2]
    ) {
        scaledValue =
            (scaledValue * TIME_LADDER[index][0]) / TIME_LADDER[index + 1][0];
        index += 1;
    }
    return {
        prefix: '',
        text: toFixed(scaledValue, decimals),
        suffix: ` ${TIME_LADDER[index][1]}`,
    };
};

const FIXED_SUFFIX: Record<string, string> = {
    percent: '%',
    bps: ' b/s',
    pps: ' p/s',
    reqps: ' req/s',
    reqpm: ' req/min',
    ops: ' ops/s',
    opm: ' ops/min',
    rps: ' rd/s',
    wps: ' wr/s',
    iops: ' io/s',
    cps: ' c/s',
};

const CURRENCY: Record<string, string> = {
    currencyUSD: '$',
    currencyGBP: '£',
    currencyEUR: '€',
};

/**
 * Formats `value` for a Grafana `unit` with `decimals` (null for automatic).
 * A blank unit or `none` is the plain number; an unknown unit is a suffix,
 * as Grafana shows a unit it does not recognise.
 */
export const formatGrafanaValue = (
    value: number,
    unit: string,
    decimals: number | null,
): FormattedValue => {
    const u = unit.trim();
    const plain = (suffix = '', prefix = ''): FormattedValue => ({
        prefix,
        text: toFixed(value, decimals),
        suffix,
    });
    if (u === '' || u === 'none') return plain();
    if (u === 'short') return scaled(value, decimals, 1000, SHORT);
    if (u === 'percentunit') {
        return {
            prefix: '',
            text: toFixed(value * 100, decimals),
            suffix: '%',
        };
    }
    if (u === 'bytes') return scaled(value, decimals, 1024, IEC_BYTES);
    if (u === 'decbytes') return scaled(value, decimals, 1000, SI_BYTES);
    if (u === 'Bps' || u === 'binBps') {
        const f = scaled(value, decimals, 1024, IEC_BYTES);
        return { ...f, suffix: `${f.suffix}/s` };
    }
    if (u === 'decBps') {
        const f = scaled(value, decimals, 1000, SI_BYTES);
        return { ...f, suffix: `${f.suffix}/s` };
    }
    if (u === 'bps') {
        const f = scaled(value, decimals, 1000, SI_BITS);
        return { ...f, suffix: `${f.suffix}/s` };
    }
    const timeUnit = TIME_UNITS.find(([name]) => name === u);
    if (timeUnit) return time(value, timeUnit[1], decimals);
    if (u in CURRENCY) return plain('', CURRENCY[u]);
    if (u.startsWith('dateTimeAs')) {
        const date = new Date(value);
        return Number.isFinite(date.getTime())
            ? { prefix: '', text: date.toISOString(), suffix: '' }
            : plain();
    }
    if (u in FIXED_SUFFIX) return plain(FIXED_SUFFIX[u]);
    const custom = /^(suffix|prefix):(.*)$/.exec(u);
    if (custom) {
        return custom[1] === 'prefix' ? plain('', custom[2]) : plain(custom[2]);
    }
    return plain(` ${u}`);
};

/** The whole formatted text, prefix + number + suffix. */
export const formatGrafanaText = (
    value: number,
    unit: string,
    decimals: number | null,
): string => {
    const { prefix, text, suffix } = formatGrafanaValue(value, unit, decimals);
    return `${prefix}${text}${suffix}`;
};
