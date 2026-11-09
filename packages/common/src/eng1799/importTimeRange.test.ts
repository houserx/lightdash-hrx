import { isValidDashboardTimeRange } from '../types/dashboardTimeRange';
import { importDashboardTimeRange } from './importTimeRange';

const codes = (result: ReturnType<typeof importDashboardTimeRange>) =>
    result.warnings.map((w) => w.code);

describe('importDashboardTimeRange', () => {
    it('keeps a relative range and an allowed refresh', () => {
        const result = importDashboardTimeRange(
            { from: 'now-24h', to: 'now' },
            '1m',
        );
        expect(result.timeRange).toEqual({
            from: 'now-24h',
            to: 'now',
            refreshInterval: '1m',
            tileTimeDimensions: {},
        });
        expect(result.warnings).toEqual([]);
    });

    it('turns absolute bounds into ISO UTC timestamps, with refresh off', () => {
        const result = importDashboardTimeRange(
            { from: '1718566619653', to: '2024-06-17T09:00:00+02:00' },
            false,
        );
        expect(result.timeRange).toMatchObject({
            from: '2024-06-16T19:36:59.653Z',
            to: '2024-06-17T07:00:00.000Z',
            refreshInterval: null,
        });
        expect(result.warnings).toEqual([]);
    });

    it('reads an offset-less timestamp as UTC with a warning', () => {
        const result = importDashboardTimeRange(
            { from: '2024-06-16', to: '2024-06-17 07:00:00' },
            '',
        );
        expect(result.timeRange).toMatchObject({
            from: '2024-06-16T00:00:00.000Z',
            to: '2024-06-17T07:00:00.000Z',
        });
        expect(codes(result)).toEqual([
            'time-range-adjusted',
            'time-range-adjusted',
        ]);
    });

    it.each([
        ['5s', '10s'],
        ['45s', '1m'],
        ['2h', '1h'],
        ['1d', '1h'],
    ])('moves refresh %s to %s with a warning', (refresh, expected) => {
        const result = importDashboardTimeRange(undefined, refresh);
        expect(result.timeRange.refreshInterval).toBe(expected);
        expect(codes(result)).toEqual(['refresh-adjusted']);
    });

    it('accepts a refresh equal to an allowed interval without a warning', () => {
        const result = importDashboardTimeRange(undefined, '60s');
        expect(result.timeRange.refreshInterval).toBe('1m');
        expect(result.warnings).toEqual([]);
    });

    it('turns an unreadable refresh off with a warning', () => {
        const result = importDashboardTimeRange(undefined, 'bogus');
        expect(result.timeRange.refreshInterval).toBeNull();
        expect(codes(result)).toEqual(['refresh-unsupported']);
    });

    it.each([
        [{ from: 'now/d', to: 'now/d' }, 'now-1d', 'now'],
        [{ from: 'now-1d/d', to: 'now-1d/d' }, 'now-2d', 'now-1d'],
        [{ from: 'now-90m/h', to: 'now' }, 'now-3h', 'now'],
        [{ from: 'now-3M', to: 'now' }, 'now-90d', 'now'],
        [{ from: 'now-1y', to: 'now' }, 'now-365d', 'now'],
    ])('approximates %j as %s to %s with a warning', (time, from, to) => {
        const result = importDashboardTimeRange(time, '');
        expect(result.timeRange).toMatchObject({ from, to });
        expect(codes(result).length).toBeGreaterThan(0);
        expect(codes(result).every((c) => c === 'time-range-adjusted')).toBe(
            true,
        );
    });

    it.each([
        [{ from: 'now', to: 'now-1h' }],
        [{ from: '2024-06-17T00:00:00Z', to: '2024-06-16T00:00:00Z' }],
        [{ from: 'now+1h', to: 'now' }],
        [{ from: 'yesterday', to: 'now' }],
        [{ to: 'now' }],
    ])('falls back to now-6h for %j with a warning', (time) => {
        const result = importDashboardTimeRange(time, '');
        expect(result.timeRange).toMatchObject({ from: 'now-6h', to: 'now' });
        expect(codes(result)).toEqual(['time-range-unsupported']);
    });

    it('uses the Grafana default with no warning when there is no range', () => {
        const result = importDashboardTimeRange(undefined, undefined);
        expect(result.timeRange).toMatchObject({
            from: 'now-6h',
            to: 'now',
            refreshInterval: null,
        });
        expect(result.warnings).toEqual([]);
    });

    it('always returns a valid Dashboard Time Range', () => {
        [
            importDashboardTimeRange(
                { from: 'now-1d/d', to: 'now-1d/d' },
                '5s',
            ),
            importDashboardTimeRange({ from: '1718566619653', to: 'now' }, ''),
            importDashboardTimeRange({ from: 'x', to: 'y' }, 3),
        ].forEach(({ timeRange }) =>
            expect(isValidDashboardTimeRange(timeRange)).toBe(true),
        );
    });
});
