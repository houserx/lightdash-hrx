/* eslint-disable */
// @ts-nocheck
// imp-cli-grafana-dashboard: `lightdash import grafana-dashboard <file.json...> --out <dir>`
// writes dashboard-as-code and SQL-chart-as-code YAML that upload accepts, a summary, and fails
// clearly on input that is not a Grafana dashboard.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    expectValidChart,
    expectValidDashboard,
    generateSlug,
    grafanaDashboard,
    importGrafanaDashboards,
    panel,
    runCli,
    tempDir,
} from './support';

describe('lightdash import grafana-dashboard', () => {
    it('is listed under lightdash import', async () => {
        const result = await runCli(['import', '--help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('grafana-dashboard');
        const help = await runCli(['import', 'grafana-dashboard', '--help']);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain('--out');
    });

    it('writes a dashboard file and its chart files', async () => {
        const run = await importGrafanaDashboards([
            grafanaDashboard('Service Health', [
                panel('timeseries', 'Request rate', { x: 0, y: 0, w: 12, h: 8 }),
                panel('stat', 'Error ratio', { x: 12, y: 0, w: 12, h: 8 }),
            ]),
        ]);
        try {
            expect(run.files).toContain(`dashboards/${generateSlug('Service Health')}.yml`);
            const dashboards = run.dashboards();
            expect(dashboards).toHaveLength(1);
            expect(dashboards[0].doc).toMatchObject({
                version: 1,
                name: 'Service Health',
                slug: generateSlug('Service Health'),
            });
            expectValidDashboard(dashboards[0].doc);
            const charts = run.charts();
            expect(charts).toHaveLength(2);
            for (const chart of charts) {
                expect(chart.doc.contentType).toBe('sql_chart');
                expectValidChart(chart.doc);
            }
            const summary = run.summary();
            expect(summary.command).toBe('grafana-dashboard');
            expect(typeof summary.warnings.total).toBe('number');
            expect(typeof summary.warnings.byCode).toBe('object');
            expect(typeof summary.todos).toBe('number');
            expect(summary.files).toEqual(expect.arrayContaining(run.files.filter((f) => f.endsWith('.yml'))));
            expect(run.result.stdout).toMatch(/1 dashboard/);
            expect(run.result.stdout).toMatch(/2 charts/);
        } finally {
            await run.cleanup();
        }
    });

    it('accepts the Grafana API export shape {dashboard, meta}', async () => {
        const run = await importGrafanaDashboards([
            {
                meta: { folderTitle: 'Platform', slug: 'wrapped' },
                dashboard: grafanaDashboard('Wrapped Export', [
                    panel('timeseries', 'Only panel', { x: 0, y: 0, w: 24, h: 8 }),
                ]),
            },
        ]);
        try {
            expect(run.dashboards().map((d) => d.doc.name)).toEqual(['Wrapped Export']);
        } finally {
            await run.cleanup();
        }
    });

    it('fails with a message naming the file for invalid input', async () => {
        const { dir, cleanup } = await tempDir();
        try {
            const broken = path.join(dir, 'broken.json');
            await writeFile(broken, '{ not json');
            const notDashboard = path.join(dir, 'not-a-dashboard.json');
            await writeFile(notDashboard, JSON.stringify({ hello: 'world' }));
            for (const file of [broken, notDashboard, path.join(dir, 'missing.json')]) {
                const result = await runCli(['import', 'grafana-dashboard', file, '--out', path.join(dir, 'out')]);
                expect(result.code).not.toBe(0);
                expect(result.stdout + result.stderr).toContain(path.basename(file));
            }
        } finally {
            await cleanup();
        }
    });
});
