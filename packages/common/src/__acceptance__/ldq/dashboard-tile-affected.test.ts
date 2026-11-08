// ldq-dashboard-time-range-tile-status: which Tiles the Dashboard Time Range affects.
// Mapped tiles and telemetry SQL tiles that use the reserved parameters are affected.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const timeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: null,
    tileTimeDimensions: {
        'tile-orders': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

describe('isTileAffectedByTimeRange', () => {
    it('is true for a tile with a designated time dimension', () => {
        expect(
            common.isTileAffectedByTimeRange({
                timeRange,
                tile: { uuid: 'tile-orders', type: 'saved_chart' },
            }),
        ).toBe(true);
    });

    it('is true for a SQL tile that uses a reserved time parameter', () => {
        expect(
            common.isTileAffectedByTimeRange({
                timeRange,
                tile: { uuid: 'tile-sql', type: 'sql_chart' },
                sql: "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            }),
        ).toBe(true);
        expect(
            common.isTileAffectedByTimeRange({
                timeRange,
                tile: { uuid: 'tile-sql', type: 'sql_chart' },
                sql: "SELECT * FROM logql('{app=\"api\"}', ${lightdash.parameters.__from}, now(), 100)",
            }),
        ).toBe(true);
    });

    it('is false for tiles with neither', () => {
        expect(
            common.isTileAffectedByTimeRange({
                timeRange,
                tile: { uuid: 'tile-other', type: 'saved_chart' },
            }),
        ).toBe(false);
        expect(
            common.isTileAffectedByTimeRange({
                timeRange,
                tile: { uuid: 'tile-sql', type: 'sql_chart' },
                sql: 'SELECT count(*) FROM ops_marts.fills_hourly',
            }),
        ).toBe(false);
        expect(
            common.isTileAffectedByTimeRange({
                timeRange,
                tile: { uuid: 'tile-note', type: 'markdown' },
            }),
        ).toBe(false);
    });

    it('is false for every tile when the dashboard has no time range', () => {
        expect(
            common.isTileAffectedByTimeRange({
                timeRange: undefined,
                tile: { uuid: 'tile-orders', type: 'saved_chart' },
            }),
        ).toBe(false);
    });
});
