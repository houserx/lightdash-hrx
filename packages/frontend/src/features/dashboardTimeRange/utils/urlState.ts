// Dashboard Time Range in the URL: `from`, `to` and `refresh` search params
// override the saved range so a viewer's chosen window can be shared.
import {
    isAbsoluteTimeExpression,
    isDashboardRefreshInterval,
    isRelativeTimeExpression,
    isValidDashboardTimeRange,
    type DashboardRefreshInterval,
} from '@lightdash/common';

export const TIME_RANGE_FROM_PARAM = 'from';
export const TIME_RANGE_TO_PARAM = 'to';
export const TIME_RANGE_REFRESH_PARAM = 'refresh';
/** `refresh` value meaning auto-refresh is off. */
export const TIME_RANGE_REFRESH_OFF = 'off';

/** The parts of a Dashboard Time Range a viewer can change and share. */
export type DashboardTimeRangeView = {
    from: string;
    to: string;
    refreshInterval: DashboardRefreshInterval | null;
};

const EPOCH_MS_PATTERN = /^\d{1,15}$/;

/**
 * A `from`/`to` param as a time expression: relative (`now-6h`), ISO-8601
 * with an offset, or epoch milliseconds (converted to ISO-8601 UTC).
 * Anything else is undefined.
 */
const parseTimeParam = (value: string | null): string | undefined => {
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (EPOCH_MS_PATTERN.test(trimmed)) {
        const date = new Date(Number(trimmed));
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    if (
        isRelativeTimeExpression(trimmed) ||
        isAbsoluteTimeExpression(trimmed)
    ) {
        return trimmed;
    }
    return undefined;
};

/** A `refresh` param: an allowed interval, null for `off`, else undefined. */
const parseRefreshParam = (
    value: string | null,
): DashboardRefreshInterval | null | undefined => {
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (trimmed === TIME_RANGE_REFRESH_OFF) return null;
    return isDashboardRefreshInterval(trimmed) ? trimmed : undefined;
};

const isValidView = (view: DashboardTimeRangeView) =>
    isValidDashboardTimeRange({ ...view, tileTimeDimensions: {} });

/**
 * The time range to view a dashboard over: valid URL params override the
 * saved range one by one; invalid params are ignored. Bounds from the URL
 * that would put `from` after `to` are ignored together. Without a saved
 * range, the URL must give both bounds, else there is no range (null).
 * Other fields of the saved range (such as tile time dimensions) are kept.
 */
export const readTimeRangeFromSearchParams = <T extends DashboardTimeRangeView>(
    params: URLSearchParams,
    saved: T | null | undefined,
): T | DashboardTimeRangeView | null => {
    const from = parseTimeParam(params.get(TIME_RANGE_FROM_PARAM));
    const to = parseTimeParam(params.get(TIME_RANGE_TO_PARAM));
    const refreshInterval = parseRefreshParam(
        params.get(TIME_RANGE_REFRESH_PARAM),
    );

    if (!saved) {
        if (from === undefined || to === undefined) return null;
        const view = { from, to, refreshInterval: refreshInterval ?? null };
        return isValidView(view) ? view : null;
    }

    if (
        from === undefined &&
        to === undefined &&
        refreshInterval === undefined
    ) {
        return saved;
    }

    const withBounds = {
        from: from ?? saved.from,
        to: to ?? saved.to,
        refreshInterval: saved.refreshInterval,
    };
    const bounds = isValidView(withBounds)
        ? { from: withBounds.from, to: withBounds.to }
        : { from: saved.from, to: saved.to };

    return {
        ...saved,
        ...bounds,
        refreshInterval:
            refreshInterval === undefined
                ? saved.refreshInterval
                : refreshInterval,
    };
};

/**
 * A copy of `params` carrying the range as `from`, `to` and `refresh`
 * (`off` when refresh is off). Other params are kept.
 */
export const writeTimeRangeToSearchParams = (
    params: URLSearchParams,
    range: DashboardTimeRangeView,
): URLSearchParams => {
    const next = new URLSearchParams(params);
    next.set(TIME_RANGE_FROM_PARAM, range.from);
    next.set(TIME_RANGE_TO_PARAM, range.to);
    next.set(
        TIME_RANGE_REFRESH_PARAM,
        range.refreshInterval ?? TIME_RANGE_REFRESH_OFF,
    );
    return next;
};
