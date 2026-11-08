import { type GrafanaValueMapping, type ResultRow } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { applyTableValueMappings, getTableCellValueMapping } from './model';

const status: GrafanaValueMapping[] = [
    {
        type: 'value',
        options: {
            '0': { text: 'Down', color: 'red', index: 0 },
            '1': { text: 'Up', index: 1 },
        },
    },
    {
        type: 'special',
        options: { match: 'null', result: { text: 'Unknown', index: 2 } },
    },
];

const row = (raw: unknown): ResultRow => ({
    s: { value: { raw, formatted: String(raw) } },
    other: { value: { raw: 0, formatted: '0' } },
});

describe('table value mappings', () => {
    it('replaces formatted text of mapped columns and keeps raw', () => {
        const rows = [row(0), row(1), row(2), row(null)];
        const mapped = applyTableValueMappings(rows, [
            { id: 's', valueMappings: status },
            { id: 'other', valueMappings: undefined },
        ]);
        expect(mapped.map((r) => r.s.value)).toEqual([
            { raw: 0, formatted: 'Down' },
            { raw: 1, formatted: 'Up' },
            { raw: 2, formatted: '2' },
            { raw: null, formatted: 'Unknown' },
        ]);
        expect(mapped.map((r) => r.other.value.formatted)).toEqual([
            '0',
            '0',
            '0',
            '0',
        ]);
        // unmatched rows and the input are not copied or mutated
        expect(mapped[2]).toBe(rows[2]);
        expect(rows[0].s.value.formatted).toBe('0');
    });

    it('returns the same rows when no column has mappings', () => {
        const rows = [row(0)];
        expect(
            applyTableValueMappings(rows, [{ id: 's', valueMappings: [] }]),
        ).toBe(rows);
    });

    it('gives the resolved colour and skips object values', () => {
        expect(
            getTableCellValueMapping({ raw: 0, formatted: '0' }, status)?.color,
        ).toBe('#F2495C');
        expect(
            getTableCellValueMapping(
                { raw: new Date(0), formatted: 'x' },
                status,
            ),
        ).toBeUndefined();
    });
});
