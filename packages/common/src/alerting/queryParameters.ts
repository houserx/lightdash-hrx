/**
 * The reserved time-range parameters of an Alert Rule query
 * (`${ld.parameters.__from}`, `__to`, `__interval`, `__range`), resolved as
 * CONTRACTS §2 defines them for dashboards: `__from`/`__to` are ISO-8601 UTC
 * timestamps and `__interval` is (to − from) / max data points, rounded up to
 * a nice step with a 15s floor.
 */
import { formatPrometheusDuration, parsePrometheusDuration } from './durations';

/** Default number of data points `__interval` aims for. */
export const ALERT_QUERY_MAX_DATA_POINTS = 1000;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The nice steps `__interval` rounds up to (CONTRACTS §2). */
export const ALERT_QUERY_INTERVAL_STEPS_MS: readonly number[] = [
    SECOND,
    5 * SECOND,
    15 * SECOND,
    30 * SECOND,
    MINUTE,
    5 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
];

/** `__interval` is never below this. */
export const ALERT_QUERY_MIN_INTERVAL_MS = 15 * SECOND;

/**
 * `__interval` in milliseconds for a range: range / maxDataPoints rounded up
 * to the next nice step, at least 15s. Past the largest step (1d) it rounds
 * up to whole days.
 */
export const computeAlertQueryIntervalMs = (
    rangeMs: number,
    maxDataPoints: number = ALERT_QUERY_MAX_DATA_POINTS,
): number => {
    if (!Number.isFinite(rangeMs) || rangeMs < 0) {
        throw new Error(`Invalid time range ${rangeMs}ms`);
    }
    if (!Number.isInteger(maxDataPoints) || maxDataPoints < 1) {
        throw new Error(`Invalid max data points ${maxDataPoints}`);
    }
    const raw = Math.max(rangeMs / maxDataPoints, ALERT_QUERY_MIN_INTERVAL_MS);
    const step = ALERT_QUERY_INTERVAL_STEPS_MS.find((s) => s >= raw);
    return step ?? Math.ceil(raw / DAY) * DAY;
};

export type AlertQueryParameters = {
    /** ISO-8601 UTC start of the window. */
    __from: string;
    /** ISO-8601 UTC end of the window (the evaluation time). */
    __to: string;
    /** Prometheus duration string, e.g. `15m`. */
    __interval: string;
    /** Prometheus duration string for to − from. */
    __range: string;
};

/**
 * The parameters for evaluating a rule at `at` over its `timeRange` (a
 * Prometheus duration): the window is [at − timeRange, at].
 */
export const resolveAlertQueryParameters = ({
    at,
    timeRange,
}: {
    at: Date;
    timeRange: string;
}): AlertQueryParameters => {
    const to = at.getTime();
    if (!Number.isFinite(to)) {
        throw new Error('Invalid evaluation time');
    }
    const rangeMs = parsePrometheusDuration(timeRange);
    return {
        __from: new Date(to - rangeMs).toISOString(),
        __to: new Date(to).toISOString(),
        __interval: formatPrometheusDuration(
            computeAlertQueryIntervalMs(rangeMs),
        ),
        __range: formatPrometheusDuration(rangeMs),
    };
};

/**
 * A reserved reference, either bare (`${ld.parameters.__from}`, the convention
 * Investigate and the SQL Runner use) or already wrapped in single quotes
 * (`'${ld.parameters.__from}'`, the convention of earlier Alert Rule queries).
 * The reference syntax is exactly Lightdash's `parameterRegex`.
 */
const RESERVED_PARAMETER_PATTERN =
    /'\$\{(?:lightdash|ld)\.parameters\.(__from|__to|__interval|__range)\}'|\$\{(?:lightdash|ld)\.parameters\.(__from|__to|__interval|__range)\}/g;

/** A SQL string literal, as Lightdash's parameter substitution writes one. */
const quoteSqlString = (value: string): string =>
    `'${value.replaceAll("'", "''")}'`;

/**
 * Replaces `${ld.parameters.__from}`, `__to`, `__interval` and `__range` (or
 * `${lightdash.parameters.*}`) in `sql` with their values as SQL string
 * literals, exactly as Lightdash's parameter substitution
 * (`safeReplaceParameters`) does for dashboards, Investigate and the SQL
 * Runner, so the same SQL is a valid Alert Rule query. A reference already
 * wrapped in single quotes becomes the same single literal, not a doubled
 * one. Other `${ld.parameters.*}` references are left as they are.
 */
export const substituteAlertQueryParameters = (
    sql: string,
    parameters: AlertQueryParameters,
): string =>
    sql.replace(
        RESERVED_PARAMETER_PATTERN,
        (
            _match,
            quotedName: keyof AlertQueryParameters | undefined,
            bareName: keyof AlertQueryParameters,
        ) => quoteSqlString(parameters[quotedName ?? bareName]),
    );
