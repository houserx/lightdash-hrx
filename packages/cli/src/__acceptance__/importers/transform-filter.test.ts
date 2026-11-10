/* eslint-disable */
// @ts-nocheck
// imp-transform-filter: filterFieldsByName keeps only the named columns, and filterByValue
// filters rows, both in SQL around the translated query.
import { calls, codeOutsideLiterals, grafanaDashboard, importGrafanaDashboards } from './support';
import { pgPanel } from './transformsupport';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Filters', [
            pgPanel('Some fields', 0, 'SELECT created_at, merged_at, title FROM github_pulls', [
                { id: 'filterFieldsByName', options: { include: { names: ['created_at', 'title'] } } },
            ]),
            pgPanel('Pattern fields', 8, 'SELECT p50_ms, p99_ms, route FROM latency', [
                { id: 'filterFieldsByName', options: { include: { pattern: 'p\\d+_ms' } } },
            ]),
            pgPanel('Non-zero ranges', 16, 'SELECT title, range_days FROM pr_ranges', [
                {
                    id: 'filterByValue',
                    options: {
                        type: 'exclude',
                        match: 'any',
                        filters: [
                            { fieldName: 'range_days', config: { id: 'equal', options: { value: 0 } } },
                            { fieldName: 'range_days', config: { id: 'isNull', options: {} } },
                        ],
                    },
                },
            ]),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

const sqlOf = (name) => run.charts().find((c) => c.doc.name === name).doc.sql;

describe('filter transformations', () => {
    it('selects only the named fields', () => {
        const sql = sqlOf('Some fields');
        expect(calls(sql, 'platform_query')).toHaveLength(1);
        expect(codeOutsideLiterals(sql)).toMatch(/select "?created_at"? , "?title"? from/);
    });

    it('selects the fields a name pattern matches, or warns that it cannot know them', () => {
        const sql = sqlOf('Pattern fields');
        const report = run.report(run.dashboards()[0].doc.slug);
        const selected = /select "?p50_ms"? , "?p99_ms"? from/.test(codeOutsideLiterals(sql));
        expect(selected || report.includes('Pattern fields')).toBe(true);
    });

    it('excludes rows by value', () => {
        const code = codeOutsideLiterals(sqlOf('Non-zero ranges'));
        expect(code).toContain('where');
        expect(code).toContain('not');
        expect(code).toContain('range_days');
        expect(code).toMatch(/is null/);
        expect(code).toMatch(/= 0/);
    });
});
