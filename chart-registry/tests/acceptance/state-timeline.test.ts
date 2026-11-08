/**
 * Feature viz-registry-state-timeline: the `state-timeline` entry draws one
 * row per series with a segment per run of the same state over time;
 * Grafana value mappings set each state's text and colour.
 */
import { GRAFANA_RED, colorOf, getEntry, minutes, renderEntry } from './harness';

const rows = [
    ...['up', 'up', 'down', 'up'].map((state, i) => ({
        time: minutes(i),
        series: 'api',
        state,
    })),
    ...['up', 'up', 'up', 'up'].map((state, i) => ({
        time: minutes(i),
        series: 'db',
        state,
    })),
];

const MAPPINGS = JSON.stringify([
    {
        type: 'value',
        options: {
            down: { text: 'Outage', color: 'red', index: 0 },
            up: { text: 'Healthy', color: 'green', index: 1 },
        },
    },
]);

describe('state-timeline', () => {
    it('declares time, series and state fields and a valueMappings option', () => {
        const schema = getEntry('state-timeline').vizSchema;
        expect(schema.fields.map((f: { name: string }) => f.name)).toEqual(
            expect.arrayContaining(['time', 'series', 'state']),
        );
        expect(
            schema.configOptions.find((o: { name: string }) => o.name === 'valueMappings')
                ?.type,
        ).toBe('text');
    });

    it('draws a row per series and merges runs of the same state', async () => {
        const r = await renderEntry('state-timeline', {
            rows,
            waitFor: '[data-testid="state-timeline-segment"]',
        });
        expect(r.errors).toEqual([]);
        const timelineRows = r.all('[data-testid="state-timeline-row"]');
        expect(timelineRows.map((row) => row.getAttribute('data-series'))).toEqual([
            'api',
            'db',
        ]);
        const segments = (series: string) =>
            [
                ...timelineRows
                    .find((row) => row.getAttribute('data-series') === series)!
                    .querySelectorAll('[data-testid="state-timeline-segment"]'),
            ].map((s) => s.getAttribute('data-state'));
        expect(segments('api')).toEqual(['up', 'down', 'up']);
        expect(segments('db')).toEqual(['up']);
    });

    it('applies value mapping text and colour to each state', async () => {
        const r = await renderEntry('state-timeline', {
            rows,
            options: { valueMappings: MAPPINGS },
            waitFor: '[data-testid="state-timeline-segment"]',
        });
        const down = r
            .all('[data-testid="state-timeline-segment"]')
            .find((s) => s.getAttribute('data-state') === 'down')!;
        expect(colorOf(down)).toBe(GRAFANA_RED);
        expect(r.root.textContent).toContain('Outage');
    });
});
