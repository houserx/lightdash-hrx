// Dashboard Time Range resolution (docs/eng-1799/CONTRACTS.md §2).
// Relative ranges such as `now-6h` resolve to absolute ISO-8601 UTC timestamps,
// rounded down to the refresh interval, or to 10s when refresh is off, so that
// cache keys change exactly when the data should.
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

const resolveExpression = (
    expression: string,
    nowMs: number,
    bucketMs: number,
): number => {
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
 * to the refresh interval, or to 10s when there is none.
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
