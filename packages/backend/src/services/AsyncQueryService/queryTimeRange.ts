// A query's time range (Dashboard Time Range or Investigate) and Audited Query
// fields, as the async query routes receive them (CONTRACTS §2, §3).
import {
    getDashboardTimeRangeFilterId,
    getDashboardTimeRangeFilterRules,
    isValidDashboardTimeRange,
    mergeReservedValues,
    ParameterError,
    RESERVED_TIME_PARAMETER_NAMES,
    resolveReservedParameterValues,
    type DashboardFilters,
    type DashboardTimeRange,
    type ParametersValuesMap,
    type QueryAudit,
    type QueryTimeRange,
} from '@lightdash/common';

/** Throws a ParameterError unless the range has valid bounds and refresh interval. */
export const assertValidQueryTimeRange = (timeRange: QueryTimeRange): void => {
    if (
        !isValidDashboardTimeRange({
            from: timeRange.from,
            to: timeRange.to,
            refreshInterval: timeRange.refreshInterval ?? null,
            tileTimeDimensions: {},
        })
    ) {
        throw new ParameterError(
            'Invalid time range: from and to must be now, now-<duration> or ISO-8601 timestamps with from not after to, and refreshInterval one of the allowed intervals',
        );
    }
};

/**
 * Adds the reserved time parameters (`__from`, `__to`, `__interval`, `__range`)
 * resolved from `timeRange` to `parameters`, so `${ld.parameters.__from}` etc.
 * are substituted before the query is compiled and its cache key computed.
 * Relative bounds round down to the refresh interval (10s when none). A
 * same-named user parameter wins. Without a time range the parameters are
 * returned unchanged.
 */
export const withTimeRangeParameters = (
    parameters: ParametersValuesMap | undefined,
    timeRange: QueryTimeRange | undefined,
    now?: Date,
): ParametersValuesMap | undefined => {
    if (!timeRange) return parameters;
    assertValidQueryTimeRange(timeRange);
    const reserved = resolveReservedParameterValues({
        dateZoom: undefined,
        timeRange,
        refreshInterval: timeRange.refreshInterval ?? null,
        now,
    });
    const timeValues =
        RESERVED_TIME_PARAMETER_NAMES.reduce<ParametersValuesMap>(
            (acc, name) => ({ ...acc, [name]: reserved[name] }),
            {},
        );
    return mergeReservedValues(parameters, timeValues);
};

/**
 * Adds the Dashboard Time Range filter for one chart tile: an `inBetween` rule
 * on the time dimension the saved dashboard maps the tile to, over the
 * requested range. A tile that isn't mapped, or a request without a range,
 * gets the filters unchanged.
 */
export const withTimeRangeTileFilter = ({
    dashboardFilters,
    timeRange,
    savedTimeRange,
    tileUuid,
    now,
}: {
    dashboardFilters: DashboardFilters;
    timeRange: QueryTimeRange | undefined;
    savedTimeRange: DashboardTimeRange | null | undefined;
    tileUuid: string;
    now?: Date;
}): DashboardFilters => {
    if (!timeRange) return dashboardFilters;
    assertValidQueryTimeRange(timeRange);
    const tileTimeDimension = savedTimeRange?.tileTimeDimensions?.[tileUuid];
    if (!tileTimeDimension) return dashboardFilters;
    const rules = getDashboardTimeRangeFilterRules({
        timeRange: {
            from: timeRange.from,
            to: timeRange.to,
            refreshInterval: timeRange.refreshInterval ?? null,
            tileTimeDimensions: { [tileUuid]: tileTimeDimension },
        },
        tileUuids: [tileUuid],
        now,
    });
    const ruleId = getDashboardTimeRangeFilterId(tileUuid);
    return {
        ...dashboardFilters,
        dimensions: [
            ...dashboardFilters.dimensions.filter((rule) => rule.id !== ruleId),
            ...rules,
        ],
    };
};

/**
 * Trims the Audited Query fields. A present audit needs a non-empty
 * description (the engine refuses an Audited Query without one); a blank
 * ticket becomes null.
 */
export const normalizeQueryAudit = (
    audit: QueryAudit | undefined,
): QueryAudit | undefined => {
    if (audit === undefined) return undefined;
    const description = audit.description?.trim() ?? '';
    if (description.length === 0) {
        throw new ParameterError('An Audited Query needs a description');
    }
    const ticket = audit.ticket?.trim() || null;
    return { description, ticket };
};
