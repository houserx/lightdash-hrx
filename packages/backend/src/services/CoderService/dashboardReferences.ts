import {
    DashboardTileTypes,
    type DashboardAsCode,
    type DashboardAsCodeUpsertResult,
    type DashboardConfig,
    type DashboardDAO,
    type DashboardTile,
    type DashboardTileAsCode,
    type DashboardTileTarget,
    type DashboardTileTimeDimension,
    type DashboardTileWithSlug,
    type DashboardTimeRange,
    type DashboardTimeRangeAsCode,
    type DateZoomTileTarget,
    type PromotionChanges,
} from '@lightdash/common';
import { v4 as uuidv4 } from 'uuid';

type AnyChartTile = Extract<
    DashboardTileAsCode | DashboardTile,
    {
        type: DashboardTileTypes.SAVED_CHART | DashboardTileTypes.SQL_CHART;
    }
>;

export const isAnyChartTile = (
    tile: DashboardTileAsCode | DashboardTile,
): tile is AnyChartTile =>
    tile.type === DashboardTileTypes.SAVED_CHART ||
    tile.type === DashboardTileTypes.SQL_CHART;

// The portable per-tile identity: a chart tile's chart slug, or a data app
// tile's app slug. Suffixed when several tiles reference the same content.
const getTileContentSlug = (
    tile: DashboardTile | DashboardTileAsCode,
): string | undefined => {
    if (isAnyChartTile(tile)) return tile.properties.chartSlug ?? undefined;
    if (tile.type === DashboardTileTypes.DATA_APP)
        return tile.properties.appSlug ?? undefined;
    return undefined;
};

export const getTileSlugForTileUuid = (
    dashboard: DashboardDAO,
    uuid: string,
): string | undefined => {
    const tile = dashboard.tiles.find((item) => item.uuid === uuid);
    const contentSlug = tile ? getTileContentSlug(tile) : undefined;
    if (!tile || contentSlug === undefined) {
        return undefined;
    }
    const matchingTiles = dashboard.tiles.filter(
        (item) => getTileContentSlug(item) === contentSlug,
    );
    if (matchingTiles.length > 1) {
        const index = matchingTiles.findIndex((item) => item.uuid === uuid);
        return `${contentSlug}-${index + 1}`;
    }
    return contentSlug;
};

export const getFiltersWithTileSlugs = (
    dashboard: DashboardDAO,
): Required<NonNullable<DashboardAsCode['filters']>> => ({
    ...dashboard.filters,
    dimensions: dashboard.filters.dimensions.map((filter) => ({
        ...filter,
        id: undefined,
        tileTargets: Object.entries(filter.tileTargets ?? {}).reduce<
            Record<string, DashboardTileTarget>
        >((result, [tileUuid, target]) => {
            const tileSlug = getTileSlugForTileUuid(dashboard, tileUuid);
            return tileSlug ? { ...result, [tileSlug]: target } : result;
        }, {}),
    })),
});

const findTileUuid = (
    tiles: DashboardTileWithSlug[],
    tileSlug: string,
): string | undefined =>
    tiles.find(
        (tile) =>
            tile.tileSlug === tileSlug || getTileContentSlug(tile) === tileSlug,
    )?.uuid;

export const getFiltersWithTileUuids = (
    dashboard: DashboardAsCode,
    tiles: DashboardTileWithSlug[],
): DashboardDAO['filters'] => ({
    metrics: dashboard.filters?.metrics ?? [],
    tableCalculations: dashboard.filters?.tableCalculations ?? [],
    dimensions: (dashboard.filters?.dimensions ?? []).map((filter) => ({
        ...filter,
        id: uuidv4(),
        tileTargets: Object.entries(filter.tileTargets ?? {}).reduce<
            Record<string, DashboardTileTarget>
        >((result, [tileSlug, target]) => {
            const tileUuid = findTileUuid(tiles, tileSlug);
            if (!tileUuid) {
                console.error(
                    `Tile with slug ${tileSlug} not found in tilesWithUuids`,
                );
                return result;
            }
            return { ...result, [tileUuid]: target };
        }, {}),
    })),
});

export const getConfigWithDateZoomTileSlugs = (
    dashboard: DashboardDAO,
): DashboardConfig | undefined => {
    const { config } = dashboard;
    if (!config?.dateZoomConfig) return config;
    const tileTargets = Object.entries(
        config.dateZoomConfig.tileTargets ?? {},
    ).reduce<Record<string, DateZoomTileTarget>>(
        (result, [tileUuid, target]) => {
            const tileSlug = getTileSlugForTileUuid(dashboard, tileUuid);
            return tileSlug ? { ...result, [tileSlug]: target } : result;
        },
        {},
    );
    return {
        ...config,
        dateZoomConfig: { ...config.dateZoomConfig, tileTargets },
    };
};

/** Attaches skipped-tile warnings to a promotion result, omitting the key when there are none. */
export const withTileWarnings = (
    changes: PromotionChanges,
    warnings: string[],
): DashboardAsCodeUpsertResult =>
    warnings.length > 0 ? { ...changes, warnings } : changes;

export const getConfigWithDateZoomTileUuids = (
    config: DashboardConfig,
    tiles: DashboardTileWithSlug[],
): DashboardConfig => {
    if (!config.dateZoomConfig) return config;
    const tileTargets = Object.entries(
        config.dateZoomConfig.tileTargets ?? {},
    ).reduce<Record<string, DateZoomTileTarget>>(
        (result, [tileSlug, target]) => {
            const tileUuid = findTileUuid(tiles, tileSlug);
            if (!tileUuid) {
                console.error(
                    `Tile with slug ${tileSlug} not found for date zoom target`,
                );
                return result;
            }
            return { ...result, [tileUuid]: target };
        },
        {},
    );
    return {
        ...config,
        dateZoomConfig: { ...config.dateZoomConfig, tileTargets },
    };
};

/** The saved Dashboard Time Range with tile time dimensions keyed by tile slug, for download. */
export const getTimeRangeWithTileSlugs = (
    dashboard: DashboardDAO,
): DashboardTimeRangeAsCode | undefined => {
    const { timeRange } = dashboard;
    if (!timeRange) return undefined;
    const tileTimeDimensions = Object.entries(
        timeRange.tileTimeDimensions,
    ).reduce<Record<string, DashboardTileTimeDimension>>(
        (result, [tileUuid, dimension]) => {
            const tileSlug = getTileSlugForTileUuid(dashboard, tileUuid);
            return tileSlug ? { ...result, [tileSlug]: dimension } : result;
        },
        {},
    );
    return { ...timeRange, tileTimeDimensions };
};

/**
 * The uploaded time range with tile time dimensions keyed by tile uuid. Slugs that match
 * no tile are dropped and reported as warnings.
 */
export const getTimeRangeWithTileUuids = (
    timeRange: DashboardTimeRangeAsCode,
    tiles: DashboardTileWithSlug[],
): { timeRange: DashboardTimeRange; warnings: string[] } => {
    const warnings: string[] = [];
    const tileTimeDimensions = Object.entries(
        timeRange.tileTimeDimensions,
    ).reduce<Record<string, DashboardTileTimeDimension>>(
        (result, [tileSlug, dimension]) => {
            const tileUuid = findTileUuid(tiles, tileSlug);
            if (!tileUuid) {
                warnings.push(
                    `Time range tile "${tileSlug}" is not a tile on this dashboard; its time dimension was ignored`,
                );
                return result;
            }
            return { ...result, [tileUuid]: dimension };
        },
        {},
    );
    return { timeRange: { ...timeRange, tileTimeDimensions }, warnings };
};
