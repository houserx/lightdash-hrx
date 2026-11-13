/**
 * Feature viz-registry-stat-value: the `stat-sparkline` entry (Grafana
 * `stat`) shows one big value, reduced from the rows (last not-null by
 * default), with a Grafana unit and decimals, and "No data" when empty.
 */
import { getEntry, minutes, renderEntry } from './harness';

const series = (values: (number | null)[]) =>
    values.map((value, i) => ({ time: minutes(i), value }));

const statText = async (rows: Record<string, unknown>[], options = {}) => {
    const r = await renderEntry('stat-sparkline', {
        rows,
        options,
        waitFor: '[data-testid="stat-value"]',
    });
    expect(r.errors).toEqual([]);
    return r.one('[data-testid="stat-value"]').textContent?.trim();
};

describe('stat-sparkline value', () => {
    it('declares value and time fields and the stat options', () => {
        const schema = getEntry('stat-sparkline').vizSchema;
        const fields = Object.fromEntries(
            schema.fields.map((f: { name: string; type: string; required: boolean }) => [
                f.name,
                f,
            ]),
        );
        expect(fields.value.type).toBe('metric');
        expect(fields.value.required).toBe(true);
        expect(fields.time.required).toBe(false);
        const options = schema.configOptions.map((o: { name: string }) => o.name);
        expect(options).toEqual(
            expect.arrayContaining([
                'unit',
                'decimals',
                'reducer',
                'thresholds',
                'valueMappings',
                'graphMode',
                'colorMode',
            ]),
        );
    });

    it('shows the last value with its unit', async () => {
        expect(
            await statText(series([10, 42.5]), { unit: 'ms', decimals: 1 }),
        ).toMatch(/^42\.5\s?ms$/);
    });

    it('skips trailing nulls for lastNotNull', async () => {
        expect(
            await statText(series([10, 42.5, null]), {
                unit: 'ms',
                decimals: 1,
                reducer: 'lastNotNull',
            }),
        ).toMatch(/^42\.5\s?ms$/);
    });

    it.each([
        ['max', '99.0'],
        ['min', '10.0'],
        ['mean', '50.5'],
        ['sum', '151.5'],
    ])('reduces with %s', async (reducer, expected) => {
        expect(
            await statText(series([10, 99, 42.5]), {
                unit: 'none',
                decimals: 1,
                reducer,
            }),
        ).toBe(expected);
    });

    it('formats percentunit and bytes like Grafana', async () => {
        expect(
            await statText(series([0.42]), { unit: 'percentunit', decimals: 0 }),
        ).toMatch(/^42\s?%$/);
        expect(
            await statText(series([1536]), { unit: 'bytes', decimals: 1 }),
        ).toMatch(/^1\.5\s?KiB$/);
    });

    it('shows No data for empty results', async () => {
        expect(await statText([])).toBe('No data');
    });
});
