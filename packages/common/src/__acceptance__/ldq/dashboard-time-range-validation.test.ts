// ldq-dashboard-time-range-model: the persisted Dashboard Time Range shape and its
// refresh interval options (10s, 30s, 1m, 5m, 15m, 30m, 1h, or off = null).
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const valid = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: '1m',
    tileTimeDimensions: {
        'tile-uuid-1': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

describe('Dashboard Time Range model', () => {
    it('offers exactly the refresh intervals of the design', () => {
        expect(common.DASHBOARD_REFRESH_INTERVALS).toEqual([
            '10s',
            '30s',
            '1m',
            '5m',
            '15m',
            '30m',
            '1h',
        ]);
    });

    it('accepts relative and absolute ranges, with refresh on or off', () => {
        expect(common.isValidDashboardTimeRange(valid)).toBe(true);
        expect(
            common.isValidDashboardTimeRange({
                ...valid,
                refreshInterval: null,
            }),
        ).toBe(true);
        expect(
            common.isValidDashboardTimeRange({
                from: '2026-11-01T00:00:00.000Z',
                to: '2026-11-02T00:00:00.000Z',
                refreshInterval: null,
                tileTimeDimensions: {},
            }),
        ).toBe(true);
    });

    it('rejects unknown refresh intervals and unparsable bounds', () => {
        expect(
            common.isValidDashboardTimeRange({ ...valid, refreshInterval: '2m' }),
        ).toBe(false);
        expect(
            common.isValidDashboardTimeRange({ ...valid, from: 'last tuesday' }),
        ).toBe(false);
        expect(
            common.isValidDashboardTimeRange({
                ...valid,
                tileTimeDimensions: { 'tile-uuid-1': 'orders_created_at' },
            }),
        ).toBe(false);
        expect(common.isValidDashboardTimeRange(null)).toBe(false);
    });
});
