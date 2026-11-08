import {
    DashboardTileTypes,
    DimensionType,
    FieldType,
    MetricType,
    type DashboardFilterableField,
    type DashboardTile,
} from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { getTimeRangeSettingsTiles } from './tileTimeDimensions';

const field = (
    name: string,
    type: DimensionType | MetricType,
    overrides: Partial<DashboardFilterableField> = {},
) =>
    ({
        fieldType:
            type === MetricType.COUNT ? FieldType.METRIC : FieldType.DIMENSION,
        type,
        name,
        table: 'orders',
        tableLabel: 'Orders',
        label: name,
        sql: '',
        hidden: false,
        ...overrides,
    }) as DashboardFilterableField;

const tile = (
    uuid: string,
    type: DashboardTileTypes,
    properties: Record<string, unknown>,
) =>
    ({
        uuid,
        type,
        x: 0,
        y: 0,
        h: 3,
        w: 6,
        tabUuid: undefined,
        properties: { title: '', ...properties },
    }) as unknown as DashboardTile;

describe('getTimeRangeSettingsTiles', () => {
    it('lists the visible date and timestamp dimensions of each tile', () => {
        const tiles = [
            tile('chart', DashboardTileTypes.SAVED_CHART, {
                chartName: 'Orders per hour',
            }),
            tile('note', DashboardTileTypes.MARKDOWN, { title: 'Runbook' }),
            tile('untitled', DashboardTileTypes.MARKDOWN, {}),
        ];
        expect(
            getTimeRangeSettingsTiles(tiles, {
                chart: [
                    field('created_at', DimensionType.TIMESTAMP, {
                        label: 'Created at',
                    }),
                    field('shipped_date', DimensionType.DATE, {
                        label: 'Shipped date',
                    }),
                    field('status', DimensionType.STRING),
                    field('secret_at', DimensionType.TIMESTAMP, {
                        hidden: true,
                    }),
                    field('order_count', MetricType.COUNT),
                ],
            }),
        ).toEqual([
            {
                uuid: 'chart',
                name: 'Orders per hour',
                timeDimensions: [
                    {
                        fieldId: 'orders_created_at',
                        tableName: 'orders',
                        label: 'Created at',
                    },
                    {
                        fieldId: 'orders_shipped_date',
                        tableName: 'orders',
                        label: 'Shipped date',
                    },
                ],
            },
            { uuid: 'note', name: 'Runbook', timeDimensions: [] },
            { uuid: 'untitled', name: 'Untitled tile', timeDimensions: [] },
        ]);
    });

    it('gives no time dimensions while the fields are not loaded', () => {
        expect(
            getTimeRangeSettingsTiles(
                [
                    tile('chart', DashboardTileTypes.SAVED_CHART, {
                        chartName: 'Orders per hour',
                    }),
                ],
                undefined,
            ),
        ).toEqual([
            { uuid: 'chart', name: 'Orders per hour', timeDimensions: [] },
        ]);
    });
});
