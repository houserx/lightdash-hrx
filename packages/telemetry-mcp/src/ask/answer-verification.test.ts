/**
 * Port of the portal's `answer-verification.test.ts` (refs/db-query-portal@aea73de). The first seven cases are the
 * portal's, unchanged except that jest globals became vitest imports; the rest cover `extractFigures` and the
 * reporting cap.
 */
import { describe, expect, it } from 'vitest';
import { extractFigures, unverifiedFigures, type EvidenceQuery } from './answer-verification.js';

const query = (rows: Record<string, unknown>[], sql = 'SELECT 1'): EvidenceQuery => ({
    status: 'ok',
    sql,
    rows,
});

describe('unverifiedFigures', () => {
    it('accepts figures that appear in the rows, including formatted and string-typed values', () => {
        const q = [query([{ n: '14466' }, { n: 5120 }])];
        expect(
            unverifiedFigures('There are **14,466** orders; 5,120 are open.', 'how many?', q),
        ).toEqual([]);
    });

    it('flags a figure that is in no result', () => {
        const q = [query([{ n: 7 }])];
        expect(
            unverifiedFigures('There are 7 open orders and 99 closed ones.', 'how many?', q),
        ).toEqual(['99']);
    });

    it('accepts rounded figures, K/M suffixes and percentages (as fractions or percents)', () => {
        const q = [query([{ total: 1234567, share: 0.425, pct: 12.34 }])];
        const text = 'About 1.2M total, a 42.5% share, and 12.3% growth.';
        expect(unverifiedFigures(text, 'q', q)).toEqual([]);
    });

    it('accepts simple arithmetic over the results (share, difference, ratio)', () => {
        const q = [
            query([
                { status: 'paid', n: 30 },
                { status: 'rejected', n: 70 },
            ]),
        ];
        expect(unverifiedFigures('30% were paid, 40 more were rejected than paid.', 'q', q)).toEqual(
            [],
        );
        expect(unverifiedFigures('31% were paid.', 'q', q)).toEqual(['31%']);
    });

    it('accepts figures from the question, the SQL, row counts and ranks', () => {
        const q = [
            query(
                [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
                "SELECT name FROM t WHERE created > now() - interval '90 days' LIMIT 3",
            ),
        ];
        expect(
            unverifiedFigures(
                'Over the last 90 days the top 3 are a, b and c; top 12 weeks too.',
                'last 12 weeks?',
                q,
            ),
        ).toEqual([]);
    });

    it('ignores dates, years, times and list numbering', () => {
        const q = [query([{ n: 7 }])];
        const text =
            '1. On 2026-10-21 and Oct 21, 2026 at 14:30 there were 7 orders.\n2. March 3rd too.';
        expect(unverifiedFigures(text, 'q', q)).toEqual([]);
    });

    it('does nothing without a successful query', () => {
        expect(unverifiedFigures('There are 42 orders.', 'q', [])).toEqual([]);
        expect(
            unverifiedFigures('There are 42 orders.', 'q', [{ status: 'error', sql: 'x', rows: [] }]),
        ).toEqual([]);
    });

    it('ignores rows of failed queries even when another query succeeded', () => {
        const q: EvidenceQuery[] = [
            query([{ n: 7 }]),
            { status: 'error', sql: 'SELECT 99', rows: [{ n: 99 }] },
        ];
        expect(unverifiedFigures('7 open and 99 closed.', 'q', q)).toEqual(['99']);
    });

    it('reports each missing figure once and at most six', () => {
        const q = [query([{ n: 7 }])];
        const text = '11, 11, 13, 17, 19, 23, 29, 31 and 37.';
        expect(unverifiedFigures(text, 'q', q)).toEqual(['11', '13', '17', '19', '23', '29']);
    });
});

describe('extractFigures', () => {
    it('parses thousands separators, decimals, currency and K/M/B suffixes', () => {
        expect(extractFigures('$1,234.50 and 2.5k and 3M and 4 B')).toEqual([
            { raw: '$1,234.50', value: 1234.5, decimals: 2, percent: false },
            { raw: '2.5k', value: 2500, decimals: 1, percent: false },
            { raw: '3M', value: 3_000_000, decimals: 0, percent: false },
            { raw: '4 B', value: 4_000_000_000, decimals: 0, percent: false },
        ]);
    });

    it('marks percentages and skips digits inside words', () => {
        expect(extractFigures('12.3% of v2 users, 5 more')).toEqual([
            { raw: '12.3%', value: 12.3, decimals: 1, percent: true },
            { raw: '5', value: 5, decimals: 0, percent: false },
        ]);
    });
});
