/**
 * Feature viz-registry-stat-thresholds: the stat's colour comes from
 * Grafana threshold steps (named or hex colours) applied to the value; the
 * colour mode says whether it colours the value or the background.
 */
import {
    GRAFANA_GREEN,
    GRAFANA_ORANGE,
    GRAFANA_RED,
    colorOf,
    minutes,
    renderEntry,
} from './harness';

const THRESHOLDS = JSON.stringify({
    mode: 'absolute',
    steps: [
        { value: null, color: 'green' },
        { value: 80, color: '#FF9830' },
        { value: 90, color: 'red' },
    ],
});

const stat = async (value: number, options: Record<string, unknown> = {}) => {
    const r = await renderEntry('stat-sparkline', {
        rows: [{ time: minutes(0), value }],
        options: { thresholds: THRESHOLDS, ...options },
        waitFor: '[data-testid="stat"]',
    });
    expect(r.errors).toEqual([]);
    return r.one('[data-testid="stat"]');
};

describe('stat-sparkline thresholds', () => {
    it.each([
        [50, GRAFANA_GREEN],
        [85, GRAFANA_ORANGE],
        [95, GRAFANA_RED],
    ])('colours %s as %s', async (value, colour) => {
        expect(colorOf(await stat(value))).toBe(colour);
    });

    it.each(['value', 'background', 'none'])(
        'records the %s colour mode',
        async (colorMode) => {
            const el = await stat(95, { colorMode });
            expect(el.getAttribute('data-color-mode')).toBe(colorMode);
        },
    );

    it('accepts Grafana steps given as a bare array', async () => {
        const r = await renderEntry('stat-sparkline', {
            rows: [{ time: minutes(0), value: 95 }],
            options: {
                thresholds: JSON.stringify([
                    { value: null, color: 'green' },
                    { value: 90, color: 'red' },
                ]),
            },
            waitFor: '[data-testid="stat"]',
        });
        expect(colorOf(r.one('[data-testid="stat"]'))).toBe(GRAFANA_RED);
    });
});
