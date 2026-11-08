/**
 * Feature viz-registry-bar-gauge: the `bar-gauge` entry (Grafana
 * `bargauge`) draws one bar per row, filled by value between min and max,
 * horizontal or vertical, labelled with the name and formatted value.
 */
import { getEntry, renderEntry } from './harness';

const rows = [
    { name: 'api', value: 25 },
    { name: 'worker', value: 50 },
    { name: 'db', value: 100 },
];

describe('bar-gauge', () => {
    it('declares name and value fields and the gauge options', () => {
        const schema = getEntry('bar-gauge').vizSchema;
        expect(schema.fields.map((f: { name: string }) => f.name)).toEqual(
            expect.arrayContaining(['name', 'value']),
        );
        const options = Object.fromEntries(
            schema.configOptions.map((o: { name: string }) => [o.name, o]),
        );
        expect(options.orientation.type).toBe('select');
        expect(options.displayMode.type).toBe('select');
        for (const name of ['min', 'max', 'thresholds', 'unit']) {
            expect(options[name], name).toBeDefined();
        }
    });

    it.each(['horizontal', 'vertical'])('draws %s bars', async (orientation) => {
        const r = await renderEntry('bar-gauge', {
            rows,
            options: { orientation, min: 0, max: 100 },
            waitFor: '[data-testid="bar-gauge-bar"]',
        });
        expect(r.errors).toEqual([]);
        expect(r.one('[data-testid="bar-gauge"]').getAttribute('data-orientation')).toBe(
            orientation,
        );
        const bars = r.all('[data-testid="bar-gauge-bar"]');
        expect(bars.map((b) => b.getAttribute('data-name'))).toEqual([
            'api',
            'worker',
            'db',
        ]);
        expect(bars.map((b) => Number(b.getAttribute('data-fill')))).toEqual([
            0.25, 0.5, 1,
        ]);
    });

    it('labels each bar with its name and formatted value', async () => {
        const r = await renderEntry('bar-gauge', {
            rows,
            options: { min: 0, max: 100, unit: 'percent' },
            waitFor: '[data-testid="bar-gauge-bar"]',
        });
        expect(r.root.textContent).toContain('worker');
        expect(r.root.textContent).toMatch(/50\s?%/);
    });

    it('clamps values outside min and max', async () => {
        const r = await renderEntry('bar-gauge', {
            rows: [{ name: 'over', value: 150 }, { name: 'under', value: -5 }],
            options: { min: 0, max: 100 },
            waitFor: '[data-testid="bar-gauge-bar"]',
        });
        expect(
            r.all('[data-testid="bar-gauge-bar"]').map((b) => Number(b.getAttribute('data-fill'))),
        ).toEqual([1, 0]);
    });
});
