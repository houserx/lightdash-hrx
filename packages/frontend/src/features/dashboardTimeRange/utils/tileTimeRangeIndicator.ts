import {
    DashboardTileTypes,
    isTileAffectedByTimeRange,
    type IsTileAffectedByTimeRangeArgs,
} from '@lightdash/common';

/**
 * Whether a tile is marked "Not affected by the time range": the dashboard has a
 * time range, the tile shows data (saved chart or SQL chart) and the range does
 * not reach it (no time dimension mapping, no reserved time parameter in its SQL).
 * Markdown, heading, loom and data app tiles show no data, so they get no mark.
 * A SQL tile whose SQL is not known yet (still loading) gets no mark either.
 */
export const isTileMarkedNotAffectedByTimeRange = ({
    timeRange,
    tile,
    sql,
}: IsTileAffectedByTimeRangeArgs): boolean => {
    if (!timeRange) return false;
    if (tile.type === DashboardTileTypes.SAVED_CHART) {
        return !isTileAffectedByTimeRange({ timeRange, tile });
    }
    if (tile.type === DashboardTileTypes.SQL_CHART) {
        return (
            sql !== undefined &&
            !isTileAffectedByTimeRange({ timeRange, tile, sql })
        );
    }
    return false;
};
