/* eslint-disable */
// @ts-nocheck
// imp-transform-rename-organize: renameByRegex renames series in SQL, and organize renames,
// hides and orders columns in the chart config.
import { calls, grafanaDashboard, importGrafanaDashboards, panel, promTarget } from './support';
import { pgPanel, reportLinesFor } from './transformsupport';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Rename And Organize', [
            panel('timeseries', 'Success ratio', { x: 0, y: 0, w: 24, h: 8 }, {
                targets: [promTarget('sum by (job) (perc_success_total)', { legendFormat: '{{job}}' })],
                transformations: [{ id: 'renameByRegex', options: { regex: '(perc_success.*)', renamePattern: 'perc_success' } }],
            }),
            pgPanel('Cron jobs', 8, 'SELECT jobname, status, runs FROM cron.job_summary', [
                {
                    id: 'organize',
                    options: {
                        renameByName: { jobname: 'Job' },
                        excludeByName: { status: true },
                        indexByName: { runs: 0, jobname: 1 },
                    },
                },
            ]),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

const chart = (name) => run.charts().find((c) => c.doc.name === name).doc;

describe('renameByRegex and organize', () => {
    it('renames series with a regex replace in SQL', () => {
        const replace = calls(chart('Success ratio').sql, 'regexp_replace');
        expect(replace.length).toBeGreaterThanOrEqual(1);
        expect(replace.some((c) => c.args.includes('(perc_success.*)'))).toBe(true);
    });

    it('renames, hides and orders table columns', () => {
        const columns = chart('Cron jobs').config.columns;
        expect(columns.jobname).toMatchObject({ reference: 'jobname', label: 'Job', visible: true });
        expect(columns.status).toMatchObject({ reference: 'status', visible: false });
        expect(columns.runs.order).toBe(0);
        expect(columns.jobname.order).toBe(1);
    });

    it('raises no transformation warning for supported transformations', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        expect(reportLinesFor(report, 'Cron jobs')).not.toContain('transformation-unsupported');
        expect(reportLinesFor(report, 'Success ratio')).not.toContain('transformation-unsupported');
    });
});
