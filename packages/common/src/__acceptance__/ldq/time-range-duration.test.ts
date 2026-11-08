// ldq-time-range-parameter: __range is the Prometheus duration string for (to - from).
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const now = new Date('2026-11-08T10:37:43.512Z');

const range = (from: string, to = 'now') =>
    common.getReservedTimeParameterValues({ from, to }, { now }).__range;

describe('__range', () => {
    it('uses the largest whole units', () => {
        expect(range('now-6h')).toBe('6h');
        expect(range('now-15m')).toBe('15m');
        expect(range('now-30s')).toBe('30s');
        expect(range('now-24h')).toBe('1d');
        expect(range('now-7d')).toBe('7d');
    });

    it('combines units for ranges that are not whole', () => {
        expect(
            range('2026-11-01T00:00:00.000Z', '2026-11-01T01:30:00.000Z'),
        ).toBe('1h30m');
        expect(
            range('2026-11-01T00:00:00.000Z', '2026-11-02T02:00:05.000Z'),
        ).toBe('1d2h5s');
    });

    it('formats durations directly', () => {
        expect(common.formatPrometheusDuration(0)).toBe('0s');
        expect(common.formatPrometheusDuration(15_000)).toBe('15s');
        expect(common.formatPrometheusDuration(90 * 60_000)).toBe('1h30m');
        expect(common.formatPrometheusDuration(86_400_000)).toBe('1d');
    });
});
