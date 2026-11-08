import { describe, expect, it } from 'vitest';
import { capTableBytes, successResult, type TableResult } from './telemetryArgs.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function table(count: number, line: (i: number) => string, truncated = false): TableResult {
    const rows = Array.from({ length: count }, (_, i) => ({ line: line(i), n: i }));
    return { columns: ['line', 'n'], rows, rowCount: rows.length, truncated };
}

describe('capTableBytes', () => {
    it('returns a table that already fits unchanged, keeping its truncated flag', () => {
        const t = table(3, (i) => `l${i}`);
        expect(capTableBytes(t, bytes(t))).toBe(t);
        const rowCapped = table(3, (i) => `l${i}`, true);
        expect(capTableBytes(rowCapped, 1_000_000)).toBe(rowCapped);
    });

    it('keeps the longest prefix that fits, exactly at the boundary, and flags truncation', () => {
        const t = table(50, (i) => `${i} ${'x'.repeat(i % 7 * 13)}`);
        for (let kept = 0; kept < 50; kept += 1) {
            const expected = { ...t, rows: t.rows.slice(0, kept), rowCount: kept, truncated: true };
            const exact = bytes(expected);
            expect(capTableBytes(t, exact)).toEqual(expected);
            const below = capTableBytes(t, exact - 1);
            expect(below?.rowCount ?? -1).toBeLessThan(kept);
        }
    });

    it('counts UTF-8 bytes, not characters', () => {
        const t = table(10, () => 'é'.repeat(100));
        const capped = capTableBytes(t, 1_000)!;
        expect(bytes(capped)).toBeLessThanOrEqual(1_000);
        expect(capped.rowCount).toBe(capped.rows.length);
        expect(capped.rowCount).toBeLessThan(10);
        expect(capped.truncated).toBe(true);
    });

    it('stops at a row too large on its own, keeping the rows before it', () => {
        const t = table(5, (i) => (i === 2 ? 'x'.repeat(10_000) : 'ok'));
        const capped = capTableBytes(t, 1_000)!;
        expect(capped.rows.map((r) => r.n)).toEqual([0, 1]);
        expect(capped.truncated).toBe(true);
    });

    it('returns undefined when not even an empty table fits', () => {
        expect(capTableBytes(table(5, () => 'x'), 10)).toBeUndefined();
    });
});

describe('successResult', () => {
    it('keeps both the structured and the text content within the cap', () => {
        const t = table(500, (i) => `synthetic log line ${i} ${'x'.repeat(300)}`);
        const r = successResult(t, 20_000);
        expect(r.isError).toBeUndefined();
        const text = (r.content[0] as { text: string }).text;
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(20_000);
        expect(bytes(r.structuredContent)).toBeLessThanOrEqual(20_000);
        expect(JSON.parse(text)).toEqual(r.structuredContent);
        expect(r.structuredContent).toMatchObject({ truncated: true });
    });

    it('is an error result when the cap cannot hold even an empty table', () => {
        const r = successResult(table(1, () => 'x'), 10);
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toBeUndefined();
    });
});
