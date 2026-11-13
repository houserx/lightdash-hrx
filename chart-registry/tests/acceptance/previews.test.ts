/**
 * Feature viz-registry-complete: the registry publishes all six HouseRx
 * entries, and each one renders its own preview rows without errors (what
 * the chart type gallery shows before install).
 */
import { REGISTRY_SLUGS, getEntry, loadIndex, renderEntry } from './harness';

describe('registry entries', () => {
    it('lists all six entries', () => {
        const slugs = loadIndex().index.charts.map((c: { slug: string }) => c.slug);
        expect(slugs).toEqual(expect.arrayContaining(REGISTRY_SLUGS));
    });

    it.each(REGISTRY_SLUGS)('%s renders its preview', async (slug) => {
        const entry = getEntry(slug);
        const r = await renderEntry(slug, {
            rows: entry.preview.rows,
            options: entry.preview.optionValues ?? {},
        });
        expect(r.errors).toEqual([]);
        expect(r.root.children.length).toBeGreaterThan(0);
        expect(r.document.querySelectorAll('[data-testid]').length).toBeGreaterThan(0);
    });
});
