// ldq-time-absolute-range: absolute ranges pass through as ISO-8601 UTC, unrounded.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const now = new Date('2026-11-08T10:37:43.512Z');

describe('resolveTimeRange with absolute ranges', () => {
    it('normalises absolute timestamps to ISO-8601 UTC without rounding', () => {
        expect(
            common.resolveTimeRange(
                {
                    from: '2026-11-01T00:00:07.250Z',
                    to: '2026-11-01T01:30:00Z',
                },
                { now, refreshInterval: '1h' },
            ),
        ).toEqual({
            from: '2026-11-01T00:00:07.250Z',
            to: '2026-11-01T01:30:00.000Z',
        });
    });

    it('accepts an absolute start with a relative end', () => {
        expect(
            common.resolveTimeRange(
                { from: '2026-11-08T00:00:00.000Z', to: 'now' },
                { now },
            ),
        ).toEqual({
            from: '2026-11-08T00:00:00.000Z',
            to: '2026-11-08T10:37:40.000Z',
        });
    });

    it('rejects a range whose start is after its end', () => {
        expect(() =>
            common.resolveTimeRange(
                {
                    from: '2026-11-02T00:00:00.000Z',
                    to: '2026-11-01T00:00:00.000Z',
                },
                { now },
            ),
        ).toThrow();
    });
});
