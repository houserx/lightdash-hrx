/* eslint-disable */
// @ts-nocheck
// imp-roundtrip-lint: `lightdash lint`, the CLI's own content-as-code validator, accepts
// everything the dashboard and Perses importers write.
import { runCli } from './support';
import { importAllDashboards, importAllPerses } from './roundtripsupport';

describe('lightdash lint on importer output', () => {
    it('accepts the imported Grafana dashboards', async () => {
        const run = await importAllDashboards();
        try {
            const lint = await runCli(['lint', '--path', run.out]);
            expect(lint.stdout + lint.stderr).toContain('All Lightdash Code files are valid');
            expect(lint.code).toBe(0);
        } finally {
            await run.cleanup();
        }
    });

    it('accepts the imported Perses dashboards', async () => {
        const run = await importAllPerses();
        try {
            const lint = await runCli(['lint', '--path', run.out]);
            expect(lint.code).toBe(0);
        } finally {
            await run.cleanup();
        }
    });
});
