/**
 * Feature viz-grafana-thresholds: Grafana threshold steps (absolute and
 * percentage, named or hex colours) resolve to colours, and convert to the
 * built-in gauge's sections.
 */
import { describe, expect, it } from 'vitest';
import {
    getThresholdColor,
    grafanaThresholdsToGaugeSections,
    resolveGrafanaColor,
} from '../../index';

const steps = {
    mode: 'absolute' as const,
    steps: [
        { value: null, color: 'green' },
        { value: 80, color: '#FF9830' },
        { value: 90, color: 'red' },
    ],
};

describe('Grafana thresholds', () => {
    it('resolves Grafana named colours to hex', () => {
        expect(resolveGrafanaColor('green').toUpperCase()).toBe('#73BF69');
        expect(resolveGrafanaColor('red').toUpperCase()).toBe('#F2495C');
        expect(resolveGrafanaColor('orange').toUpperCase()).toBe('#FF9830');
        expect(resolveGrafanaColor('yellow').toUpperCase()).toBe('#FADE2A');
        expect(resolveGrafanaColor('blue').toUpperCase()).toBe('#5794F2');
        expect(resolveGrafanaColor('purple').toUpperCase()).toBe('#B877D9');
        expect(resolveGrafanaColor('#123456')).toBe('#123456');
    });

    it('picks the colour of the highest step at or below the value', () => {
        expect(getThresholdColor(10, steps).toUpperCase()).toBe('#73BF69');
        expect(getThresholdColor(80, steps).toUpperCase()).toBe('#FF9830');
        expect(getThresholdColor(89.9, steps).toUpperCase()).toBe('#FF9830');
        expect(getThresholdColor(95, steps).toUpperCase()).toBe('#F2495C');
    });

    it('reads percentage steps against min and max', () => {
        const pct = { ...steps, mode: 'percentage' as const };
        expect(
            getThresholdColor(450, pct, { min: 0, max: 500 }).toUpperCase(),
        ).toBe('#F2495C');
        expect(
            getThresholdColor(100, pct, { min: 0, max: 500 }).toUpperCase(),
        ).toBe('#73BF69');
    });

    it('converts steps to gauge sections between min and max', () => {
        const sections = grafanaThresholdsToGaugeSections(steps, {
            min: 0,
            max: 100,
        });
        expect(
            sections.map((s) => ({
                min: s.min,
                max: s.max,
                color: s.color.toUpperCase(),
            })),
        ).toEqual([
            { min: 0, max: 80, color: '#73BF69' },
            { min: 80, max: 90, color: '#FF9830' },
            { min: 90, max: 100, color: '#F2495C' },
        ]);
    });
});
