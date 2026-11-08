/**
 * Feature viz-registry-histogram: the `histogram` entry buckets the values
 * of a field into equal-width bars and counts them; nulls are ignored.
 */
import { getEntry, renderEntry } from './harness';

const rows = Array.from({ length: 100 }, (_, i) => ({ value: i }));

describe('histogram', () => {
    it('declares a value field and a bucket count option', () => {
        const schema = getEntry('histogram').vizSchema;
        expect(schema.fields.map((f: { name: string }) => f.name)).toContain('value');
        expect(
            schema.configOptions.find((o: { name: string }) => o.name === 'bucketCount')
                ?.type,
        ).toBe('number');
    });

    it('draws bucketCount bars that count every value', async () => {
        const r = await renderEntry('histogram', {
            rows: [...rows, { value: null }],
            options: { bucketCount: 5 },
            waitFor: '[data-testid="histogram-bar"]',
        });
        expect(r.errors).toEqual([]);
        const bars = r.all('[data-testid="histogram-bar"]');
        expect(bars).toHaveLength(5);
        expect(bars.map((b) => Number(b.getAttribute('data-count')))).toEqual([
            20, 20, 20, 20, 20,
        ]);
        expect(Number(bars[0].getAttribute('data-from'))).toBe(0);
        expect(Number(bars[4].getAttribute('data-to'))).toBeCloseTo(99, 5);
    });

    it('handles a single distinct value', async () => {
        const r = await renderEntry('histogram', {
            rows: [{ value: 3 }, { value: 3 }],
            options: { bucketCount: 4 },
            waitFor: '[data-testid="histogram-bar"]',
        });
        const total = r
            .all('[data-testid="histogram-bar"]')
            .reduce((sum, b) => sum + Number(b.getAttribute('data-count')), 0);
        expect(total).toBe(2);
    });
});
