// Dashboard Time Range tile filters (CONTEXT.md): the time range applies to
// every Tile that has a designated time dimension, and only to that Tile.
import { type DashboardTimeRange } from '../types/dashboardTimeRange';
import {
    FilterOperator,
    type DashboardFilterRule,
    type DashboardTileTargets,
} from '../types/filter';
import { resolveTimeRange } from './timeRange';

/** Prefix of the ids of filter rules built from the Dashboard Time Range. */
export const DASHBOARD_TIME_RANGE_FILTER_ID_PREFIX = 'dashboard-time-range';

/**
 * Stable id of the time range rule for a tile. It does not change between
 * calls, so the tile's query and cache key only change when the range does.
 */
export const getDashboardTimeRangeFilterId = (tileUuid: string): string =>
    `${DASHBOARD_TIME_RANGE_FILTER_ID_PREFIX}:${tileUuid}`;

export type GetDashboardTimeRangeFilterRulesArgs = {
    timeRange: DashboardTimeRange | null | undefined;
    /**
     * Every tile uuid on the dashboard. Each rule targets its own tile and is
     * excluded (`false`) from all the others listed here. A tile missing from
     * this list would get the rule by default, so pass them all.
     */
    tileUuids: string[];
    /** Clock to resolve relative bounds against. Defaults to the current time. */
    now?: Date;
};

/**
 * Builds one `inBetween` dashboard filter rule per tile mapped to a time
 * dimension, on that tile's own dimension and scoped to that tile only.
 * Relative bounds are resolved to absolute UTC timestamps rounded down to the
 * refresh interval (or 10s), as for the reserved time parameters. Mappings for
 * tiles that are no longer on the dashboard are ignored.
 */
export const getDashboardTimeRangeFilterRules = ({
    timeRange,
    tileUuids,
    now,
}: GetDashboardTimeRangeFilterRulesArgs): DashboardFilterRule[] => {
    if (!timeRange) return [];
    const mappedTileUuids = tileUuids.filter(
        (tileUuid) => timeRange.tileTimeDimensions?.[tileUuid] !== undefined,
    );
    if (mappedTileUuids.length === 0) return [];

    const { from, to } = resolveTimeRange(timeRange, {
        now,
        refreshInterval: timeRange.refreshInterval,
    });

    return mappedTileUuids.map((tileUuid) => {
        const { fieldId, tableName } = timeRange.tileTimeDimensions[tileUuid];
        const target = { fieldId, tableName };
        const tileTargets = tileUuids.reduce<DashboardTileTargets>(
            (acc, otherTileUuid) => ({
                ...acc,
                [otherTileUuid]: otherTileUuid === tileUuid ? target : false,
            }),
            {},
        );
        return {
            id: getDashboardTimeRangeFilterId(tileUuid),
            label: undefined,
            target,
            operator: FilterOperator.IN_BETWEEN,
            values: [from, to],
            tileTargets,
        };
    });
};
