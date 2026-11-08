/**
 * Feature viz-registry-heatmap: the `heatmap` entry draws a time x bucket
 * grid (for latency histograms) with one cell per (time, bucket) in the
 * results, coloured by value, buckets ordered numerically with +Inf last.
 */
import { colorOf, getEntry, minutes, renderEntry } from './harness';

const BUCKETS = ['0.5', '+Inf', '0.1', '1'];
const rows = [0, 1, 2].flatMap((t) =>
    BUCKETS.map((bucket, b) => ({
        time: minutes(t),
        bucket,
        value: t * 10 + b,
    })),
);

describe('heatmap', () => {
    it('declares time, bucket and value fields', () => {
        const fields = getEntry('heatmap').vizSchema.fields;
        expect(fields.map((f: { name: string }) => f.name)).toEqual(
            expect.arrayContaining(['time', 'bucket', 'value']),
        );
        expect(fields.find((f: { name: string }) => f.name === 'value').type).toBe(
            'metric',
        );
    });

    it('draws one cell per time and bucket', async () => {
        const r = await renderEntry('heatmap', {
            rows,
            waitFor: '[data-testid="heatmap-cell"]',
        });
        expect(r.errors).toEqual([]);
        const cells = r.all('[data-testid="heatmap-cell"]');
        expect(cells).toHaveLength(12);
        const cell = cells.find(
            (c) =>
                c.getAttribute('data-bucket') === '0.1' &&
                c.getAttribute('data-time') === minutes(2),
        )!;
        expect(cell).toBeDefined();
        expect(cell.getAttribute('data-value')).toBe('22');
    });

    it('colours the largest value differently from the smallest', async () => {
        const r = await renderEntry('heatmap', {
            rows,
            waitFor: '[data-testid="heatmap-cell"]',
        });
        const byValue = (v: string) =>
            r.all('[data-testid="heatmap-cell"]').find(
                (c) => c.getAttribute('data-value') === v,
            )!;
        expect(colorOf(byValue('0'))).toMatch(/^#[0-9A-F]{6}$/);
        expect(colorOf(byValue('23'))).toMatch(/^#[0-9A-F]{6}$/);
        expect(colorOf(byValue('0'))).not.toBe(colorOf(byValue('23')));
    });

    it('orders buckets numerically with +Inf last', async () => {
        const r = await renderEntry('heatmap', {
            rows,
            waitFor: '[data-testid="heatmap-y-label"]',
        });
        expect(
            r.all('[data-testid="heatmap-y-label"]').map((l) => l.textContent?.trim()),
        ).toEqual(['0.1', '0.5', '1', '+Inf']);
    });

    it('draws only the cells present in sparse results', async () => {
        const r = await renderEntry('heatmap', {
            rows: rows.slice(0, 7),
            waitFor: '[data-testid="heatmap-cell"]',
        });
        expect(r.all('[data-testid="heatmap-cell"]')).toHaveLength(7);
    });
});
