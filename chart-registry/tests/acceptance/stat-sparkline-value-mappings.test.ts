/**
 * Feature viz-registry-stat-value-mappings: Grafana value mappings replace
 * the stat's text (and colour), including the null special.
 */
import { GRAFANA_RED, colorOf, minutes, renderEntry } from './harness';

const MAPPINGS = JSON.stringify([
    {
        type: 'value',
        options: {
            '0': { text: 'Down', color: 'red', index: 0 },
            '1': { text: 'Up', color: 'green', index: 1 },
        },
    },
    { type: 'special', options: { match: 'null', result: { text: 'N/A', index: 2 } } },
]);

const stat = async (value: number | null) =>
    renderEntry('stat-sparkline', {
        rows: [{ time: minutes(0), value }],
        options: { valueMappings: MAPPINGS },
        waitFor: '[data-testid="stat-value"]',
    });

describe('stat-sparkline value mappings', () => {
    it('shows mapped text in the mapping colour', async () => {
        const r = await stat(0);
        expect(r.errors).toEqual([]);
        expect(r.one('[data-testid="stat-value"]').textContent?.trim()).toBe('Down');
        expect(colorOf(r.one('[data-testid="stat"]'))).toBe(GRAFANA_RED);
    });

    it('maps the null special', async () => {
        const r = await stat(null);
        expect(r.one('[data-testid="stat-value"]').textContent?.trim()).toBe('N/A');
    });

    it('leaves unmapped values alone', async () => {
        const r = await stat(7);
        expect(r.one('[data-testid="stat-value"]').textContent).toContain('7');
    });
});
