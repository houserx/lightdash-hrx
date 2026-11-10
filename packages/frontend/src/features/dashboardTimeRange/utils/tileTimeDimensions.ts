import {
    getItemId,
    isDateItem,
    isDimension,
    type DashboardFilterableField,
    type DashboardTile,
    type DashboardTileTimeDimension,
} from '@lightdash/common';
import { getTileTitle } from '../../dashboardControls/tileProps';

export type TimeRangeSettingsTimeDimension = DashboardTileTimeDimension & {
    label: string;
};

/** A tile as the time range settings list it. */
export type TimeRangeSettingsTile = {
    uuid: string;
    name: string;
    timeDimensions: TimeRangeSettingsTimeDimension[];
};

/**
 * The tiles of a dashboard with the date and timestamp dimensions each one can
 * be filtered on (from the dashboard's filterable fields per tile).
 */
export const getTimeRangeSettingsTiles = (
    tiles: DashboardTile[],
    filterableFieldsByTileUuid:
        | Record<string, DashboardFilterableField[]>
        | undefined,
): TimeRangeSettingsTile[] =>
    tiles.map((tile) => ({
        uuid: tile.uuid,
        name: getTileTitle(tile, 'Untitled tile'),
        timeDimensions: (filterableFieldsByTileUuid?.[tile.uuid] ?? [])
            .filter(
                (field) =>
                    isDimension(field) && !field.hidden && isDateItem(field),
            )
            .map((field) => ({
                fieldId: getItemId(field),
                tableName: field.table,
                label: field.label,
            })),
    }));
