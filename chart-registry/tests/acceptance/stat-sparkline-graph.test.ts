/**
 * Feature viz-registry-stat-sparkline: with graph mode "area" and a time
 * field, the stat draws a sparkline of the series behind the value; with
 * "none" it draws none.
 */
import { minutes, renderEntry } from './harness';

const rows = [3, 1, 4, 1, 5, 9].map((value, i) => ({ time: minutes(i), value }));

describe('stat-sparkline sparkline', () => {
    it('draws an SVG sparkline through every point', async () => {
        const r = await renderEntry('stat-sparkline', {
            rows,
            options: { graphMode: 'area' },
            waitFor: '[data-testid="stat-sparkline"]',
        });
        expect(r.errors).toEqual([]);
        const spark = r.one('[data-testid="stat-sparkline"]');
        expect(spark.getAttribute('data-points')).toBe('6');
        const svgPath = spark.querySelector('path');
        expect(svgPath?.getAttribute('d')?.length ?? 0).toBeGreaterThan(10);
    });

    it('sorts the points by time', async () => {
        const r = await renderEntry('stat-sparkline', {
            rows: [...rows].reverse(),
            options: { graphMode: 'area' },
            waitFor: '[data-testid="stat-value"]',
        });
        // the big value is the last point in time, not the last row
        expect(r.one('[data-testid="stat-value"]').textContent).toContain('9');
    });

    it('draws no sparkline in graph mode none', async () => {
        const r = await renderEntry('stat-sparkline', {
            rows,
            options: { graphMode: 'none' },
            waitFor: '[data-testid="stat-value"]',
        });
        expect(r.all('[data-testid="stat-sparkline"]')).toHaveLength(0);
    });
});
