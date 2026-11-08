// Dashboard Time Range (CONTEXT.md): the single relative or absolute window a
// dashboard is viewed over, with an optional auto-refresh interval, applied to
// every Tile that has a designated time dimension.
import {
    isAbsoluteTimeExpression,
    isRelativeTimeExpression,
    resolveTimeRange,
} from '../utils/timeRange';

/** Auto-refresh intervals a dashboard can use; `null` means refresh is off. */
export const DASHBOARD_REFRESH_INTERVALS = [
    '10s',
    '30s',
    '1m',
    '5m',
    '15m',
    '30m',
    '1h',
] as const;

export type DashboardRefreshInterval =
    (typeof DASHBOARD_REFRESH_INTERVALS)[number];

/** The time dimension a Tile is filtered on by the Dashboard Time Range. */
export type DashboardTileTimeDimension = {
    fieldId: string;
    tableName: string;
};

export type DashboardTimeRange = {
    /** `now`, `now-<n><s|m|h|d|w>`, or an ISO-8601 timestamp with an offset. */
    from: string;
    /** `now`, `now-<n><s|m|h|d|w>`, or an ISO-8601 timestamp with an offset. */
    to: string;
    /** One of DASHBOARD_REFRESH_INTERVALS, or null when refresh is off. */
    refreshInterval: DashboardRefreshInterval | null;
    /** Time dimension per tile uuid; tiles not listed are not filtered. */
    tileTimeDimensions: Record<string, DashboardTileTimeDimension>;
};

export const isDashboardRefreshInterval = (
    value: unknown,
): value is DashboardRefreshInterval =>
    typeof value === 'string' &&
    (DASHBOARD_REFRESH_INTERVALS as readonly string[]).includes(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

const isTimeExpression = (value: unknown): value is string =>
    typeof value === 'string' &&
    (isRelativeTimeExpression(value) || isAbsoluteTimeExpression(value));

const isTileTimeDimension = (
    value: unknown,
): value is DashboardTileTimeDimension =>
    isPlainObject(value) &&
    isNonEmptyString(value.fieldId) &&
    isNonEmptyString(value.tableName);

/**
 * True when `from` is not after `to`. Only checked when both bounds are of the
 * same kind (both relative or both absolute): a mixed range's order depends on
 * the clock, so it is checked when the range is resolved instead.
 */
const isOrdered = (from: string, to: string): boolean => {
    if (isRelativeTimeExpression(from) !== isRelativeTimeExpression(to)) {
        return true;
    }
    try {
        resolveTimeRange({ from, to }, { now: new Date(0) });
        return true;
    } catch {
        return false;
    }
};

/**
 * Validates a Dashboard Time Range: relative or absolute bounds, a refresh
 * interval from DASHBOARD_REFRESH_INTERVALS or null (off), and tile time
 * dimensions given as `{ fieldId, tableName }` per tile uuid.
 */
export const isValidDashboardTimeRange = (
    value: unknown,
): value is DashboardTimeRange => {
    if (!isPlainObject(value)) return false;
    const { from, to, refreshInterval, tileTimeDimensions } = value;
    if (!isTimeExpression(from) || !isTimeExpression(to)) return false;
    if (!isOrdered(from, to)) return false;
    if (
        refreshInterval !== null &&
        !isDashboardRefreshInterval(refreshInterval)
    )
        return false;
    if (!isPlainObject(tileTimeDimensions)) return false;
    return Object.values(tileTimeDimensions).every(isTileTimeDimension);
};
