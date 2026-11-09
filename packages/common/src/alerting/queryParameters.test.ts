import { describe, expect, it } from 'vitest';
import {
    computeAlertQueryIntervalMs,
    resolveAlertQueryParameters,
    substituteAlertQueryParameters,
} from './queryParameters';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('computeAlertQueryIntervalMs', () => {
    it('rounds range / 1000 up to the next nice step', () => {
        expect(computeAlertQueryIntervalMs(7 * DAY)).toBe(15 * MINUTE);
        expect(computeAlertQueryIntervalMs(DAY)).toBe(5 * MINUTE);
        expect(computeAlertQueryIntervalMs(1000 * MINUTE)).toBe(MINUTE);
        expect(computeAlertQueryIntervalMs(30 * DAY)).toBe(60 * MINUTE);
    });

    it('never goes below 15s', () => {
        expect(computeAlertQueryIntervalMs(10 * MINUTE)).toBe(15_000);
        expect(computeAlertQueryIntervalMs(0)).toBe(15_000);
    });

    it('rounds up to whole days past the largest step', () => {
        expect(computeAlertQueryIntervalMs(1000 * DAY)).toBe(DAY);
        expect(computeAlertQueryIntervalMs(1500 * DAY)).toBe(2 * DAY);
    });

    it('honours max data points', () => {
        expect(computeAlertQueryIntervalMs(DAY, 100)).toBe(15 * MINUTE);
    });

    it('rejects invalid input', () => {
        expect(() => computeAlertQueryIntervalMs(-1)).toThrow();
        expect(() => computeAlertQueryIntervalMs(DAY, 0)).toThrow();
    });
});

describe('resolveAlertQueryParameters', () => {
    it('resolves the window ending at the evaluation time', () => {
        expect(
            resolveAlertQueryParameters({
                at: new Date('2026-11-08T09:00:00Z'),
                timeRange: '7d',
            }),
        ).toEqual({
            __from: '2026-11-01T09:00:00.000Z',
            __to: '2026-11-08T09:00:00.000Z',
            __interval: '15m',
            __range: '7d',
        });
    });

    it('throws on an invalid time range or time', () => {
        expect(() =>
            resolveAlertQueryParameters({ at: new Date(), timeRange: 'x' }),
        ).toThrow();
        expect(() =>
            resolveAlertQueryParameters({
                at: new Date('nope'),
                timeRange: '1m',
            }),
        ).toThrow();
    });
});

describe('substituteAlertQueryParameters', () => {
    const parameters = {
        __from: '2026-11-01T09:00:00.000Z',
        __to: '2026-11-08T09:00:00.000Z',
        __interval: '15m',
        __range: '7d',
    };

    it('quotes every reserved parameter, as often as it appears', () => {
        expect(
            substituteAlertQueryParameters(
                'ts >= ${ld.parameters.__from} AND ts < ${ld.parameters.__to} AND step = ${lightdash.parameters.__interval} AND ${ld.parameters.__from} < ${ld.parameters.__range}',
                parameters,
            ),
        ).toBe(
            "ts >= '2026-11-01T09:00:00.000Z' AND ts < '2026-11-08T09:00:00.000Z' AND step = '15m' AND '2026-11-01T09:00:00.000Z' < '7d'",
        );
    });

    it('does not double the quotes of an already quoted reference', () => {
        expect(
            substituteAlertQueryParameters(
                "ts >= '${ld.parameters.__from}' AND step = ${ld.parameters.__interval}",
                parameters,
            ),
        ).toBe("ts >= '2026-11-01T09:00:00.000Z' AND step = '15m'");
    });

    it('matches references exactly as Lightdash does', () => {
        expect(
            substituteAlertQueryParameters(
                'step = ${ ld.parameters.__interval }',
                parameters,
            ),
        ).toBe('step = ${ ld.parameters.__interval }');
    });

    it('leaves other parameters alone', () => {
        expect(
            substituteAlertQueryParameters(
                "WHERE env = '${ld.parameters.env}'",
                parameters,
            ),
        ).toBe("WHERE env = '${ld.parameters.env}'");
    });
});
