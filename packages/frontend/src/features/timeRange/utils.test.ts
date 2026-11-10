import { describe, expect, it } from 'vitest';
import {
    getTimeRangeInputError,
    getTimeRangeLabel,
    QUICK_TIME_RANGES,
} from './utils';

describe('getTimeRangeLabel', () => {
    it('names ranges that end at now', () => {
        expect(getTimeRangeLabel({ from: 'now-6h', to: 'now' })).toBe(
            'Last 6 hours',
        );
        expect(getTimeRangeLabel({ from: 'now-1h', to: 'now' })).toBe(
            'Last 1 hour',
        );
        expect(getTimeRangeLabel({ from: 'now-15m', to: 'now' })).toBe(
            'Last 15 minutes',
        );
        expect(getTimeRangeLabel({ from: 'now-2w', to: 'now' })).toBe(
            'Last 2 weeks',
        );
    });

    it('shows other ranges as their bounds', () => {
        expect(
            getTimeRangeLabel({
                from: '2026-11-01T00:00:00.000Z',
                to: '2026-11-02T00:00:00.000Z',
            }),
        ).toBe('2026-11-01T00:00:00.000Z to 2026-11-02T00:00:00.000Z');
        expect(getTimeRangeLabel({ from: 'now-2d', to: 'now-1d' })).toBe(
            'now-2d to now-1d',
        );
    });

    it('has a unique label per quick range', () => {
        const labels = QUICK_TIME_RANGES.map(getTimeRangeLabel);
        expect(new Set(labels).size).toBe(labels.length);
        expect(labels).toContain('Last 15 minutes');
        expect(labels).toContain('Last 7 days');
    });
});

describe('getTimeRangeInputError', () => {
    it('accepts absolute and relative bounds', () => {
        expect(
            getTimeRangeInputError({
                from: '2026-11-01T00:00:00.000Z',
                to: '2026-11-02T00:00:00.000Z',
            }),
        ).toBeUndefined();
        expect(
            getTimeRangeInputError({ from: 'now-1d', to: 'now' }),
        ).toBeUndefined();
    });

    it('rejects unparseable or reversed bounds', () => {
        expect(
            getTimeRangeInputError({ from: 'yesterday', to: 'now' }),
        ).toMatch(/^From/);
        expect(
            getTimeRangeInputError({
                from: 'now-1h',
                to: '2026-11-02T00:00:00',
            }),
        ).toMatch(/^To/);
        expect(
            getTimeRangeInputError({
                from: '2026-11-02T00:00:00.000Z',
                to: '2026-11-01T00:00:00.000Z',
            }),
        ).toBe('From must not be after To');
    });
});
