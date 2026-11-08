// ldq-time-interval-parameter: __interval is (to - from) / max data points (default 1000),
// rounded up to a nice step, floor 15s (CONTRACTS §2).
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const now = new Date('2026-11-08T10:37:43.512Z');

const interval = (from: string, maxDataPoints?: number) =>
    common.getReservedTimeParameterValues(
        { from, to: 'now' },
        maxDataPoints === undefined ? { now } : { now, maxDataPoints },
    ).__interval;

describe('__interval', () => {
    it('rounds up to the next nice step', () => {
        expect(interval('now-6h')).toBe('30s'); // 21.6s
        expect(interval('now-24h')).toBe('5m'); // 86.4s
        expect(interval('now-7d')).toBe('15m'); // 604.8s
        expect(interval('now-30d')).toBe('1h'); // 2592s
        expect(interval('now-12h')).toBe('1m'); // 43.2s
    });

    it('never goes below 15s', () => {
        expect(interval('now-15m')).toBe('15s'); // 0.9s
        expect(interval('now-1h')).toBe('15s'); // 3.6s
        expect(interval('now-3h')).toBe('15s'); // 10.8s
    });

    it('honours a custom max data points', () => {
        expect(interval('now-6h', 100)).toBe('5m'); // 216s
        expect(interval('now-1h', 60)).toBe('1m'); // 60s exactly
    });

    it('returns all four reserved values together', () => {
        expect(
            common.getReservedTimeParameterValues(
                { from: 'now-6h', to: 'now' },
                { now },
            ),
        ).toEqual({
            __from: '2026-11-08T04:37:40.000Z',
            __to: '2026-11-08T10:37:40.000Z',
            __interval: '30s',
            __range: '6h',
        });
    });
});
