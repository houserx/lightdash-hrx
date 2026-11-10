/* eslint-disable */
// @ts-nocheck
// imp-transform-convert-config: convertFieldType casts in SQL; configFromData and any other
// transformation the importer can't express is a transformation-unsupported warning.
import { codeOutsideLiterals, grafanaDashboard, importGrafanaDashboards } from './support';
import { pgPanel, reportLinesFor } from './transformsupport';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Convert And Config', [
            pgPanel('Throttles', 0, "SELECT day, '3' AS throttled FROM throttles", [
                { id: 'convertFieldType', options: { conversions: [{ targetField: 'throttled', destinationType: 'number' }], fields: {} } },
            ]),
            pgPanel('Config from data', 8, 'SELECT 1 AS max, 2 AS v', [{ id: 'configFromData', options: {} }], 'gauge'),
            pgPanel('Matrix', 16, 'SELECT a, b, c FROM t', [{ id: 'groupingToMatrix', options: {} }]),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

describe('convertFieldType and unsupported transformations', () => {
    it('casts the converted field', () => {
        const sql = run.charts().find((c) => c.doc.name === 'Throttles').doc.sql;
        expect(codeOutsideLiterals(sql)).toMatch(/cast \( "?throttled"? as (double|float|numeric|double precision|float8)/);
    });

    it('warns about configFromData and unknown transformations', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        expect(reportLinesFor(report, 'Config from data')).toContain('transformation-unsupported');
        expect(reportLinesFor(report, 'Matrix')).toContain('transformation-unsupported');
        expect(reportLinesFor(report, 'Matrix')).toContain('groupingToMatrix');
        expect(run.summary().warnings.byCode['transformation-unsupported']).toBe(2);
    });
});
