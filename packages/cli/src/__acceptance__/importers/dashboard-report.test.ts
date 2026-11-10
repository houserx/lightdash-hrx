/* eslint-disable */
// @ts-nocheck
// imp-dashboard-import-report: each imported dashboard gets reports/<slug>/IMPORT-REPORT.md
// listing every warning (code, panel, message) and every TODO tile, with counts that match
// import-summary.json.
import { DATASOURCES_TF, generateSlug, grafanaDashboard, importGrafanaDashboards, panel } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Report One', [
            panel('news', 'Blog feed', { x: 0, y: 0, w: 12, h: 6 }, { targets: [] }),
            panel('timeseries', 'Elastic errors', { x: 12, y: 0, w: 12, h: 6 }, {
                datasource: { type: 'elasticsearch', uid: 'es' },
                targets: [{ refId: 'A', datasource: { type: 'elasticsearch', uid: 'es' }, query: 'status:500' }],
            }),
        ]),
        grafanaDashboard('Report Two', [panel('timeseries', 'Clean panel', { x: 0, y: 0, w: 24, h: 8 })]),
    ], ['--datasources', DATASOURCES_TF]);
});
afterAll(() => run?.cleanup());

describe('IMPORT-REPORT.md', () => {
    it('is written once per dashboard', () => {
        expect(run.files).toContain(`reports/${generateSlug('Report One')}/IMPORT-REPORT.md`);
        expect(run.files).toContain(`reports/${generateSlug('Report Two')}/IMPORT-REPORT.md`);
    });

    it('lists every warning with its code and panel', () => {
        const report = run.report(generateSlug('Report One'));
        expect(report).toContain('Report One');
        expect(report).toContain('panel-dropped');
        expect(report).toContain('Blog feed');
        expect(report).toContain('datasource-unsupported');
        expect(report).toContain('Elastic errors');
    });

    it('lists the TODO tiles', () => {
        const report = run.report(generateSlug('Report One'));
        expect(report).toMatch(/TODO/);
        expect(report).toContain('elasticsearch');
    });

    it('agrees with import-summary.json', () => {
        const summary = run.summary();
        const total = Object.values(summary.warnings.byCode).reduce((a, b) => a + b, 0);
        expect(total).toBe(summary.warnings.total);
        expect(summary.todos).toBe(1);
        expect(summary.warnings.byCode['panel-dropped']).toBe(1);
        const two = run.report(generateSlug('Report Two'));
        expect(two).toMatch(/no warnings/i);
    });
});
