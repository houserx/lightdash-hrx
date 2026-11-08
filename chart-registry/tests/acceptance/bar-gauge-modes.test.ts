/**
 * Feature viz-registry-bar-gauge-modes: bars take their colour from the
 * Grafana thresholds; "basic" mode fills a bar in its threshold colour and
 * "gradient" mode fills it with a gradient through the threshold colours.
 */
import { GRAFANA_GREEN, GRAFANA_RED, colorOf, renderEntry } from './harness';

const THRESHOLDS = JSON.stringify({
    mode: 'absolute',
    steps: [
        { value: null, color: 'green' },
        { value: 80, color: 'red' },
    ],
});
const rows = [
    { name: 'calm', value: 20 },
    { name: 'hot', value: 90 },
];

const bars = async (displayMode: string) => {
    const r = await renderEntry('bar-gauge', {
        rows,
        options: { displayMode, thresholds: THRESHOLDS, min: 0, max: 100 },
        waitFor: '[data-testid="bar-gauge-bar"]',
    });
    expect(r.errors).toEqual([]);
    return r;
};

describe('bar-gauge display modes', () => {
    it('colours basic bars by threshold', async () => {
        const r = await bars('basic');
        const [calm, hot] = r.all('[data-testid="bar-gauge-bar"]');
        expect(calm.getAttribute('data-mode')).toBe('basic');
        expect(colorOf(calm)).toBe(GRAFANA_GREEN);
        expect(colorOf(hot)).toBe(GRAFANA_RED);
    });

    it('fills gradient bars with a gradient', async () => {
        const r = await bars('gradient');
        for (const bar of r.all('[data-testid="bar-gauge-bar"]')) {
            expect(bar.getAttribute('data-mode')).toBe('gradient');
            const hasSvgGradient =
                r.document.querySelector('linearGradient') !== null;
            const hasCssGradient = (bar.getAttribute('style') ?? '').includes(
                'linear-gradient',
            );
            expect(hasSvgGradient || hasCssGradient).toBe(true);
        }
        // the bar colour is still its threshold colour
        expect(colorOf(r.all('[data-testid="bar-gauge-bar"]')[1])).toBe(GRAFANA_RED);
    });
});
