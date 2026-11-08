// ldq-dashboard-time-range-tile-filters: the Dashboard Time Range applies to every Tile
// with a designated time dimension, as an inBetween filter scoped to that Tile only.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const now = new Date('2026-11-08T10:37:43.512Z');

const timeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: '1m',
    tileTimeDimensions: {
        'tile-orders': { fieldId: 'orders_created_at', tableName: 'orders' },
        'tile-fills': { fieldId: 'fills_filled_at', tableName: 'fills' },
    },
};

describe('getDashboardTimeRangeFilterRules', () => {
    it('builds one resolved inBetween rule per mapped tile', () => {
        const rules: any[] = common.getDashboardTimeRangeFilterRules({
            timeRange,
            tileUuids: ['tile-orders', 'tile-fills', 'tile-markdown'],
            now,
        });
        expect(rules).toHaveLength(2);
        const orders = rules.find(
            (rule) => rule.target.fieldId === 'orders_created_at',
        );
        expect(orders).toMatchObject({
            target: { fieldId: 'orders_created_at', tableName: 'orders' },
            operator: 'inBetween',
            values: ['2026-11-08T04:37:00.000Z', '2026-11-08T10:37:00.000Z'],
        });
        expect(typeof orders.id).toBe('string');
        expect(orders.tileTargets).toEqual({
            'tile-orders': {
                fieldId: 'orders_created_at',
                tableName: 'orders',
            },
            'tile-fills': false,
            'tile-markdown': false,
        });
    });

    it('returns no rules without a time range or without mappings', () => {
        expect(
            common.getDashboardTimeRangeFilterRules({
                timeRange: undefined,
                tileUuids: ['tile-orders'],
                now,
            }),
        ).toEqual([]);
        expect(
            common.getDashboardTimeRangeFilterRules({
                timeRange: { ...timeRange, tileTimeDimensions: {} },
                tileUuids: ['tile-orders'],
                now,
            }),
        ).toEqual([]);
    });
});
