/* eslint-disable */
// @ts-nocheck
// imp-cli-perses-dashboard: `lightdash import perses-dashboard <file.json|yaml> --out <dir>`
// converts a Perses dashboard (YAML or JSON) into the same dashboard and SQL chart YAML as the
// Grafana importer, and fails clearly on a file that is not a Perses dashboard.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PERSES, expectValidChart, expectValidDashboard, generateSlug, importPerses, runCli, tempDir } from './support';

describe('lightdash import perses-dashboard', () => {
    it('is listed under lightdash import', async () => {
        const result = await runCli(['import', '--help']);
        expect(result.stdout).toContain('perses-dashboard');
    });

    it('imports a YAML and a JSON dashboard', async () => {
        const run = await importPerses([path.join(PERSES, 'node-overview.yaml'), path.join(PERSES, 'api-latency.json')]);
        try {
            const names = run.dashboards().map((d) => d.doc.name).sort();
            expect(names).toEqual(['API latency', 'Node overview']);
            expect(run.files).toContain(`dashboards/${generateSlug('Node overview')}.yml`);
            for (const d of run.dashboards()) expectValidDashboard(d.doc);
            for (const c of run.charts()) expectValidChart(c.doc);
            expect(run.files).toContain(`reports/${generateSlug('API latency')}/IMPORT-REPORT.md`);
            expect(run.summary().command).toBe('perses-dashboard');
        } finally {
            await run.cleanup();
        }
    });

    it('fails with a message naming the file for a non-Perses file', async () => {
        const { dir, cleanup } = await tempDir();
        try {
            const file = path.join(dir, 'grafana-not-perses.json');
            await writeFile(file, JSON.stringify({ title: 'Grafana', panels: [] }));
            const result = await runCli(['import', 'perses-dashboard', file, '--out', path.join(dir, 'out')]);
            expect(result.code).not.toBe(0);
            expect(result.stdout + result.stderr).toContain('grafana-not-perses.json');
        } finally {
            await cleanup();
        }
    });
});
