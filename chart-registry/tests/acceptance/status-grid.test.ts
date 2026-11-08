/**
 * Feature viz-registry-status-grid: the `status-grid` entry draws a
 * coloured cell per series (a "health overview"), coloured by Grafana
 * thresholds on the series' latest value, with value mapping text.
 */
import { GRAFANA_GREEN, GRAFANA_RED, colorOf, getEntry, minutes, renderEntry } from './harness';

const THRESHOLDS = JSON.stringify({
    mode: 'absolute',
    steps: [
        { value: null, color: 'red' },
        { value: 1, color: 'green' },
    ],
});
const MAPPINGS = JSON.stringify([
    {
        type: 'value',
        options: {
            '0': { text: 'DOWN', index: 0 },
            '1': { text: 'UP', index: 1 },
        },
    },
]);
const rows = [
    { time: minutes(0), series: 'api', value: 0 },
    { time: minutes(1), series: 'api', value: 1 },
    { time: minutes(0), series: 'db', value: 1 },
    { time: minutes(1), series: 'db', value: 0 },
    { time: minutes(1), series: 'queue', value: 1 },
];

describe('status-grid', () => {
    it('declares series and value fields and its options', () => {
        const schema = getEntry('status-grid').vizSchema;
        expect(schema.fields.map((f: { name: string }) => f.name)).toEqual(
            expect.arrayContaining(['series', 'value']),
        );
        const options = schema.configOptions.map((o: { name: string }) => o.name);
        expect(options).toEqual(
            expect.arrayContaining(['thresholds', 'valueMappings', 'columns']),
        );
    });

    it('draws a cell per series coloured by its latest value', async () => {
        const r = await renderEntry('status-grid', {
            rows,
            options: { thresholds: THRESHOLDS, valueMappings: MAPPINGS, columns: 3 },
            waitFor: '[data-testid="status-grid-cell"]',
        });
        expect(r.errors).toEqual([]);
        const cells = r.all('[data-testid="status-grid-cell"]');
        expect(cells.map((c) => c.getAttribute('data-series'))).toEqual([
            'api',
            'db',
            'queue',
        ]);
        const bySeries = Object.fromEntries(
            cells.map((c) => [c.getAttribute('data-series'), c]),
        );
        expect(colorOf(bySeries.api)).toBe(GRAFANA_GREEN);
        expect(colorOf(bySeries.db)).toBe(GRAFANA_RED);
        expect(bySeries.db.textContent).toContain('db');
        expect(bySeries.db.textContent).toContain('DOWN');
        expect(bySeries.api.textContent).toContain('UP');
    });

    it('lays the cells out in the configured number of columns', async () => {
        const r = await renderEntry('status-grid', {
            rows,
            options: { columns: 2 },
            waitFor: '[data-testid="status-grid"]',
        });
        expect(r.one('[data-testid="status-grid"]').getAttribute('data-columns')).toBe(
            '2',
        );
    });
});
