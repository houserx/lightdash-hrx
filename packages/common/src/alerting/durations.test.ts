import { formatPrometheusDuration, parsePrometheusDuration } from './durations';

describe('parsePrometheusDuration', () => {
    it.each([
        ['30s', 30_000],
        ['5m', 300_000],
        ['1h30m', 5_400_000],
        ['1d', 86_400_000],
        ['1w', 604_800_000],
        ['1y', 31_536_000_000],
        ['250ms', 250],
        ['1m30s500ms', 90_500],
        ['0s', 0],
        ['0', 0],
    ])('parses %s', (input, expected) => {
        expect(parsePrometheusDuration(input)).toBe(expected);
    });

    it.each([
        '',
        '5 minutes',
        '-1m',
        '1.5h',
        '30m1h',
        '1h1h',
        ' 5m',
        '5',
        '5M',
    ])('rejects %j', (input) => {
        expect(() => parsePrometheusDuration(input)).toThrow();
    });
});

describe('formatPrometheusDuration', () => {
    it.each([
        [0, '0s'],
        [250, '250ms'],
        [30_000, '30s'],
        [3_600_000, '1h'],
        [5_400_000, '1h30m'],
        [90_500, '1m30s500ms'],
        [86_400_000, '1d'],
        [691_200_000, '1w1d'],
    ])('formats %d as %s', (input, expected) => {
        expect(formatPrometheusDuration(input)).toBe(expected);
    });

    it('rejects negative and fractional values', () => {
        expect(() => formatPrometheusDuration(-1)).toThrow();
        expect(() => formatPrometheusDuration(1.5)).toThrow();
    });

    it('round-trips', () => {
        ['30s', '5m', '1h30m', '2d12h', '250ms'].forEach((s) => {
            expect(formatPrometheusDuration(parsePrometheusDuration(s))).toBe(
                s,
            );
        });
    });
});
