// Dashboard Time Range resolution (docs/eng-1799/CONTRACTS.md §2).
// Relative ranges such as `now-6h` resolve to absolute ISO-8601 UTC timestamps,
// rounded down to the refresh interval, or to 10s when refresh is off, so that
// cache keys change exactly when the data should. Absolute ISO-8601 timestamps
// pass through unrounded, normalised to UTC.
import { ParameterError } from '../types/errors';

export type TimeRangeInput = {
    from: string;
    to: string;
};

export type ResolvedTimeRange = {
    from: string;
    to: string;
};

export type ResolveTimeRangeOptions = {
    /** Clock to resolve `now` against. Defaults to the current time. */
    now?: Date;
    /** Refresh interval as a duration (e.g. '1m'); null, undefined or 'off' means none. */
    refreshInterval?: string | null;
};

/** Rounding bucket used when the dashboard has no refresh interval. */
export const DEFAULT_TIME_RANGE_ROUNDING_MS = 10_000;

const UNIT_MS = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
} as const;

const DURATION_PATTERN = /^(\d+)([smhdw])$/;
const RELATIVE_PATTERN = /^now(?:-(\d+)([smhdw]))?$/;
// Full ISO-8601 date-time with an explicit offset (Z or ±hh:mm), so the instant
// never depends on the server's local time zone.
const ABSOLUTE_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Parses a duration such as `30s`, `5m` or `2w` into milliseconds. */
export const parseTimeRangeDuration = (duration: string): number => {
    const match = DURATION_PATTERN.exec(duration.trim());
    if (!match) {
        throw new ParameterError(`Invalid duration "${duration}"`);
    }
    const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
    if (ms <= 0) {
        throw new ParameterError(`Duration "${duration}" must be positive`);
    }
    return ms;
};

/** True when the expression is relative to now: `now` or `now-<n><unit>`. */
export const isRelativeTimeExpression = (expression: string): boolean =>
    RELATIVE_PATTERN.test(expression.trim());

const roundingMs = (refreshInterval: string | null | undefined): number => {
    if (
        refreshInterval === undefined ||
        refreshInterval === null ||
        refreshInterval === 'off'
    ) {
        return DEFAULT_TIME_RANGE_ROUNDING_MS;
    }
    return parseTimeRangeDuration(refreshInterval);
};

/** True when the expression is an ISO-8601 date-time with an explicit offset. */
export const isAbsoluteTimeExpression = (expression: string): boolean => {
    const match = ABSOLUTE_PATTERN.exec(expression.trim());
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match
        .slice(1, 7)
        .map((part) => Number(part ?? 0));
    // Date.parse rolls impossible dates over (Feb 30 -> Mar 2), so check the calendar.
    const calendar = new Date(Date.UTC(year, month - 1, day));
    return (
        calendar.getUTCFullYear() === year &&
        calendar.getUTCMonth() === month - 1 &&
        calendar.getUTCDate() === day &&
        hour < 24 &&
        minute < 60 &&
        second < 60 &&
        !Number.isNaN(Date.parse(expression.trim()))
    );
};

const resolveExpression = (
    expression: string,
    nowMs: number,
    bucketMs: number,
): number => {
    if (isAbsoluteTimeExpression(expression)) {
        return Date.parse(expression.trim());
    }
    const match = RELATIVE_PATTERN.exec(expression.trim());
    if (!match) {
        throw new ParameterError(
            `Cannot parse time range expression "${expression}"`,
        );
    }
    const offsetMs = match[1]
        ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
        : 0;
    const instant = nowMs - offsetMs;
    return Math.floor(instant / bucketMs) * bucketMs;
};

/**
 * Resolves a Dashboard Time Range to absolute ISO-8601 UTC timestamps.
 * Relative expressions (`now`, `now-6h`; units s, m, h, d, w) are rounded down
 * to the refresh interval, or to 10s when there is none. Absolute ISO-8601
 * timestamps with an explicit offset are kept exactly (no rounding).
 */
export const resolveTimeRange = (
    range: TimeRangeInput,
    options: ResolveTimeRangeOptions = {},
): ResolvedTimeRange => {
    const nowMs = (options.now ?? new Date()).getTime();
    if (Number.isNaN(nowMs)) {
        throw new ParameterError('Invalid clock for time range resolution');
    }
    const bucketMs = roundingMs(options.refreshInterval);
    const fromMs = resolveExpression(range.from, nowMs, bucketMs);
    const toMs = resolveExpression(range.to, nowMs, bucketMs);
    if (fromMs > toMs) {
        throw new ParameterError(
            `Time range start "${range.from}" is after its end "${range.to}"`,
        );
    }
    return {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
    };
};

/** Default number of data points `__interval` divides the range into. */
export const DEFAULT_MAX_DATA_POINTS = 1000;

/** Smallest `__interval` ever returned. */
export const MIN_TIME_INTERVAL_MS = 15_000;

/** Nice steps `__interval` rounds up to (CONTRACTS §2). */
export const TIME_INTERVAL_STEPS_MS: readonly number[] = [
    1_000,
    5_000,
    15_000,
    30_000,
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    3 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    86_400_000,
];

const FORMAT_UNITS: ReadonlyArray<[string, number]> = [
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
    ['s', UNIT_MS.s],
    ['ms', 1],
];

/**
 * Formats milliseconds as a Prometheus duration string using the largest whole
 * units, combined when needed: 90 minutes is `1h30m`, a day is `1d`, zero is `0s`.
 */
export const formatPrometheusDuration = (durationMs: number): string => {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new ParameterError(`Invalid duration ${durationMs}ms`);
    }
    let remaining = Math.floor(durationMs);
    if (remaining === 0) return '0s';
    let formatted = '';
    FORMAT_UNITS.forEach(([unit, unitMs]) => {
        const count = Math.floor(remaining / unitMs);
        if (count > 0) {
            formatted += `${count}${unit}`;
            remaining -= count * unitMs;
        }
    });
    return formatted;
};

/**
 * `__interval` in milliseconds: the range divided by the max data points,
 * rounded up to the next nice step, never below 15s. Ranges needing more than
 * the largest step (1d) round up to a whole number of days.
 */
export const getTimeIntervalMs = (
    rangeMs: number,
    maxDataPoints: number = DEFAULT_MAX_DATA_POINTS,
): number => {
    if (!Number.isInteger(maxDataPoints) || maxDataPoints <= 0) {
        throw new ParameterError(
            `Max data points must be a positive integer, got ${maxDataPoints}`,
        );
    }
    const rawMs = Math.max(rangeMs / maxDataPoints, MIN_TIME_INTERVAL_MS);
    const step = TIME_INTERVAL_STEPS_MS.find((stepMs) => stepMs >= rawMs);
    return step ?? Math.ceil(rawMs / UNIT_MS.d) * UNIT_MS.d;
};

export type ReservedTimeParameterValues = {
    __from: string;
    __to: string;
    __interval: string;
    __range: string;
};

export type ReservedTimeParameterOptions = ResolveTimeRangeOptions & {
    /** Data points `__interval` divides the range into. Defaults to 1000. */
    maxDataPoints?: number;
};

/**
 * Resolves a Dashboard Time Range to the reserved time parameters
 * `__from`, `__to`, `__interval` and `__range` (CONTRACTS §2).
 */
export const getReservedTimeParameterValues = (
    range: TimeRangeInput,
    options: ReservedTimeParameterOptions = {},
): ReservedTimeParameterValues => {
    const { from, to } = resolveTimeRange(range, options);
    const rangeMs = Date.parse(to) - Date.parse(from);
    return {
        __from: from,
        __to: to,
        __interval: formatPrometheusDuration(
            getTimeIntervalMs(rangeMs, options.maxDataPoints),
        ),
        __range: formatPrometheusDuration(rangeMs),
    };
};
