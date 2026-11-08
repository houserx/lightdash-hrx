/**
 * Feature viz-log-levels: log levels are normalised the way Grafana's logs
 * panel does it, and each level has Grafana's default colour.
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOG_LEVEL_COLORS,
    LOG_LEVELS,
    getLogLevelColor,
    normalizeLogLevel,
} from '../../index';

describe('log levels', () => {
    it('lists the seven Grafana levels in severity order', () => {
        expect(LOG_LEVELS).toEqual([
            'critical',
            'error',
            'warning',
            'info',
            'debug',
            'trace',
            'unknown',
        ]);
    });

    it("uses Grafana's default colours", () => {
        const lower = Object.fromEntries(
            Object.entries(DEFAULT_LOG_LEVEL_COLORS).map(([k, v]) => [
                k,
                String(v).toLowerCase(),
            ]),
        );
        expect(lower).toEqual({
            critical: '#705da0',
            error: '#e24d42',
            warning: '#eab839',
            info: '#7eb26d',
            debug: '#1f78c1',
            trace: '#6ed0e0',
            unknown: '#8e8e8e',
        });
    });

    it.each([
        ['ERROR', 'error'],
        ['err', 'error'],
        ['eror', 'error'],
        ['warn', 'warning'],
        ['WARNING', 'warning'],
        ['crit', 'critical'],
        ['critical', 'critical'],
        ['fatal', 'critical'],
        ['emerg', 'critical'],
        ['alert', 'critical'],
        ['info', 'info'],
        ['information', 'info'],
        ['notice', 'info'],
        ['dbug', 'debug'],
        ['debug', 'debug'],
        ['trace', 'trace'],
        [' Info ', 'info'],
    ])('normalises %s to %s', (raw, level) => {
        expect(normalizeLogLevel(raw)).toBe(level);
    });

    it.each([null, undefined, '', 'banana', 42])(
        'treats %s as unknown',
        (raw) => {
            expect(normalizeLogLevel(raw)).toBe('unknown');
        },
    );

    it('lets a chart override a level colour and falls back to the default', () => {
        expect(getLogLevelColor('error', { error: '#000000' })).toBe(
            '#000000',
        );
        expect(getLogLevelColor('info', { error: '#000000' }).toLowerCase()).toBe(
            '#7eb26d',
        );
        expect(getLogLevelColor('debug').toLowerCase()).toBe('#1f78c1');
    });
});
