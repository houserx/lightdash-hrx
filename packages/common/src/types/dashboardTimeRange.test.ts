import {
    DASHBOARD_REFRESH_INTERVALS,
    isDashboardRefreshInterval,
    isValidDashboardTimeRange,
} from './dashboardTimeRange';

const valid = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: '5m',
    tileTimeDimensions: {
        'tile-1': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

describe('isDashboardRefreshInterval', () => {
    it.each(DASHBOARD_REFRESH_INTERVALS)('accepts %s', (interval) => {
        expect(isDashboardRefreshInterval(interval)).toBe(true);
    });

    it.each(['2m', 'off', '', '60s', 60, null, undefined])(
        'rejects %s',
        (interval) => {
            expect(isDashboardRefreshInterval(interval)).toBe(false);
        },
    );
});

describe('isValidDashboardTimeRange', () => {
    it('accepts every listed refresh interval and off', () => {
        DASHBOARD_REFRESH_INTERVALS.forEach((refreshInterval) => {
            expect(
                isValidDashboardTimeRange({ ...valid, refreshInterval }),
            ).toBe(true);
        });
        expect(
            isValidDashboardTimeRange({ ...valid, refreshInterval: null }),
        ).toBe(true);
    });

    it('accepts absolute and mixed ranges', () => {
        expect(
            isValidDashboardTimeRange({
                ...valid,
                from: '2026-11-01T00:00:00+02:00',
                to: '2026-11-02T00:00:00.000Z',
            }),
        ).toBe(true);
        expect(
            isValidDashboardTimeRange({
                ...valid,
                from: '2026-11-01T00:00:00.000Z',
                to: 'now',
            }),
        ).toBe(true);
    });

    it('rejects other refresh intervals, including a missing one', () => {
        expect(
            isValidDashboardTimeRange({ ...valid, refreshInterval: 'off' }),
        ).toBe(false);
        expect(
            isValidDashboardTimeRange({ ...valid, refreshInterval: '2h' }),
        ).toBe(false);
        const { refreshInterval, ...withoutRefresh } = valid;
        expect(isValidDashboardTimeRange(withoutRefresh)).toBe(false);
    });

    it('rejects reversed ranges', () => {
        expect(
            isValidDashboardTimeRange({ ...valid, from: 'now', to: 'now-1h' }),
        ).toBe(false);
        expect(
            isValidDashboardTimeRange({
                ...valid,
                from: '2026-11-02T00:00:00Z',
                to: '2026-11-01T00:00:00Z',
            }),
        ).toBe(false);
    });

    it('rejects malformed tile time dimensions', () => {
        expect(
            isValidDashboardTimeRange({ ...valid, tileTimeDimensions: [] }),
        ).toBe(false);
        expect(
            isValidDashboardTimeRange({
                ...valid,
                tileTimeDimensions: { 'tile-1': { fieldId: 'a' } },
            }),
        ).toBe(false);
        const { tileTimeDimensions, ...withoutTiles } = valid;
        expect(isValidDashboardTimeRange(withoutTiles)).toBe(false);
    });
});
