// ldq-time-relative-resolution: relative ranges resolve to absolute UTC timestamps,
// rounded down to the refresh interval, or to 10s when there is none (CONTRACTS §2).
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const now = new Date('2026-11-08T10:37:43.512Z');

describe('resolveTimeRange with relative ranges', () => {
    it('rounds down to 10s when there is no refresh interval', () => {
        expect(
            common.resolveTimeRange({ from: 'now-6h', to: 'now' }, { now }),
        ).toEqual({
            from: '2026-11-08T04:37:40.000Z',
            to: '2026-11-08T10:37:40.000Z',
        });
        expect(
            common.resolveTimeRange(
                { from: 'now-6h', to: 'now' },
                { now, refreshInterval: null },
            ),
        ).toEqual({
            from: '2026-11-08T04:37:40.000Z',
            to: '2026-11-08T10:37:40.000Z',
        });
    });

    it('rounds down to the refresh interval', () => {
        expect(
            common.resolveTimeRange(
                { from: 'now-6h', to: 'now' },
                { now, refreshInterval: '1m' },
            ),
        ).toEqual({
            from: '2026-11-08T04:37:00.000Z',
            to: '2026-11-08T10:37:00.000Z',
        });
        expect(
            common.resolveTimeRange(
                { from: 'now-1h', to: 'now' },
                { now, refreshInterval: '5m' },
            ),
        ).toEqual({
            from: '2026-11-08T09:35:00.000Z',
            to: '2026-11-08T10:35:00.000Z',
        });
        expect(
            common.resolveTimeRange(
                { from: 'now-15m', to: 'now' },
                { now, refreshInterval: '30s' },
            ),
        ).toEqual({
            from: '2026-11-08T10:22:30.000Z',
            to: '2026-11-08T10:37:30.000Z',
        });
    });

    it('supports s, m, h, d and w units and a relative end', () => {
        expect(
            common.resolveTimeRange(
                { from: 'now-30s', to: 'now' },
                { now },
            ).from,
        ).toBe('2026-11-08T10:37:10.000Z');
        expect(
            common.resolveTimeRange({ from: 'now-7d', to: 'now' }, { now })
                .from,
        ).toBe('2026-11-01T10:37:40.000Z');
        expect(
            common.resolveTimeRange({ from: 'now-2w', to: 'now' }, { now })
                .from,
        ).toBe('2026-10-25T10:37:40.000Z');
        expect(
            common.resolveTimeRange({ from: 'now-2h', to: 'now-1h' }, { now }),
        ).toEqual({
            from: '2026-11-08T08:37:40.000Z',
            to: '2026-11-08T09:37:40.000Z',
        });
    });

    it('is stable inside one bucket and moves at the bucket boundary', () => {
        const range = { from: 'now-6h', to: 'now' };
        const a = common.resolveTimeRange(range, {
            now: new Date('2026-11-08T10:37:40.000Z'),
        });
        const b = common.resolveTimeRange(range, {
            now: new Date('2026-11-08T10:37:49.999Z'),
        });
        const c = common.resolveTimeRange(range, {
            now: new Date('2026-11-08T10:37:50.000Z'),
        });
        expect(b).toEqual(a);
        expect(c.to).toBe('2026-11-08T10:37:50.000Z');
        expect(c).not.toEqual(a);
    });

    it('rejects expressions it cannot parse', () => {
        expect(() =>
            common.resolveTimeRange({ from: 'yesterday', to: 'now' }, { now }),
        ).toThrow();
        expect(() =>
            common.resolveTimeRange({ from: 'now-6x', to: 'now' }, { now }),
        ).toThrow();
    });
});
