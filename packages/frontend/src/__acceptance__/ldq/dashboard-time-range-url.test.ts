// ldq-dashboard-time-range-url: URL params from, to and refresh override the saved Dashboard
// Time Range and make a view shareable.
import { load } from './load';

let url: any;

beforeAll(async () => {
    url = await load('../../features/dashboardTimeRange/utils/urlState');
}, 120_000);

const saved = { from: 'now-6h', to: 'now', refreshInterval: '1m' };

describe('Dashboard Time Range URL state', () => {
    it('uses the saved range when the URL has none', () => {
        expect(
            url.readTimeRangeFromSearchParams(new URLSearchParams(''), saved),
        ).toEqual(saved);
        expect(
            url.readTimeRangeFromSearchParams(new URLSearchParams(''), null),
        ).toBeNull();
    });

    it('lets URL params override the saved range', () => {
        expect(
            url.readTimeRangeFromSearchParams(
                new URLSearchParams('from=now-24h&to=now&refresh=5m'),
                saved,
            ),
        ).toEqual({ from: 'now-24h', to: 'now', refreshInterval: '5m' });
        expect(
            url.readTimeRangeFromSearchParams(
                new URLSearchParams('refresh=off'),
                saved,
            ),
        ).toEqual({ from: 'now-6h', to: 'now', refreshInterval: null });
    });

    it('accepts absolute bounds as ISO or epoch milliseconds', () => {
        expect(
            url.readTimeRangeFromSearchParams(
                new URLSearchParams(
                    'from=2026-11-01T00:00:00.000Z&to=1793577600000',
                ),
                null,
            ),
        ).toEqual({
            from: '2026-11-01T00:00:00.000Z',
            to: '2026-11-02T00:00:00.000Z',
            refreshInterval: null,
        });
    });

    it('ignores invalid values', () => {
        expect(
            url.readTimeRangeFromSearchParams(
                new URLSearchParams('from=banana&refresh=2m'),
                saved,
            ),
        ).toEqual(saved);
    });

    it('writes a shareable URL and keeps other params', () => {
        const params = url.writeTimeRangeToSearchParams(
            new URLSearchParams('tab=overview'),
            { from: 'now-1h', to: 'now', refreshInterval: null },
        );
        expect(params.get('tab')).toBe('overview');
        expect(params.get('from')).toBe('now-1h');
        expect(params.get('to')).toBe('now');
        expect(params.get('refresh')).toBe('off');
        expect(
            url.readTimeRangeFromSearchParams(params, saved),
        ).toEqual({ from: 'now-1h', to: 'now', refreshInterval: null });
    });
});
