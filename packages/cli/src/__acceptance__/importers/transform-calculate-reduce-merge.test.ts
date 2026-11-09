/* eslint-disable */
// @ts-nocheck
// imp-transform-calculate-reduce-merge: calculateField (binary) adds a computed column,
// reduce aggregates each field, and merge combines the targets into one result, all in SQL.
import { calls, codeOutsideLiterals, grafanaDashboard, importGrafanaDashboards } from './support';
import { pgPanel, reportLinesFor } from './transformsupport';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Calculate Reduce Merge', [
            pgPanel('Error ratio', 0, 'SELECT day, errors, total FROM daily_requests', [
                {
                    id: 'calculateField',
                    options: { mode: 'binary', binary: { left: 'errors', operator: '/', right: 'total' }, alias: 'ratio', replaceFields: false },
                },
            ]),
            pgPanel('Run count', 8, 'SELECT jobname, runs FROM cron_runs', [{ id: 'reduce', options: { reducers: ['count'] } }], 'stat'),
            pgPanel('Merged', 16, ['SELECT name, 1 AS v FROM a', 'SELECT name, 2 AS v FROM b'], [{ id: 'merge', options: {} }]),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

const sqlOf = (name) => run.charts().find((c) => c.doc.name === name).doc.sql;

describe('calculateField, reduce and merge', () => {
    it('adds the calculated column', () => {
        const code = codeOutsideLiterals(sqlOf('Error ratio'));
        expect(code).toMatch(/"?errors"? \/ "?total"?/);
        expect(code).toMatch(/as "?ratio"?/);
    });

    it('reduces with the reducer', () => {
        expect(codeOutsideLiterals(sqlOf('Run count'))).toMatch(/\bcount \(/);
    });

    it('merges the targets', () => {
        const sql = sqlOf('Merged');
        expect(calls(sql, 'platform_query')).toHaveLength(2);
        expect(codeOutsideLiterals(sql)).toContain('union all');
        const report = run.report(run.dashboards()[0].doc.slug);
        expect(reportLinesFor(report, 'Merged')).not.toContain('transformation-unsupported');
    });
});
