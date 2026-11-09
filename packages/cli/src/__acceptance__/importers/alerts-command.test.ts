/* eslint-disable */
// @ts-nocheck
// imp-cli-grafana-alerts: `lightdash import grafana-alerts --rules <tf...> --contact-points <tf>
// --policy <tf> --out <dir>` writes the alerting-as-code layout that `lightdash upload
// --alerting-only` reads, plus ROUTING-FIXES.md, IMPORT-REPORT.md and a summary; bad input
// fails with a message naming the file.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { expectValidAlerting, runCli, tempDir } from './support';

const RULES = ruleGroup('api', [
    rule({ name: 'API down', data: promData('A', 'up{job="api"}') + reduceThreshold('A', 'lt', 1), labels: { team: 'infra' }, annotations: { summary: 'The API is down' } }),
]);

describe('lightdash import grafana-alerts', () => {
    it('is listed under lightdash import', async () => {
        const result = await runCli(['import', '--help']);
        expect(result.stdout).toContain('grafana-alerts');
        const help = await runCli(['import', 'grafana-alerts', '--help']);
        expect(help.code).toBe(0);
        for (const option of ['--rules', '--contact-points', '--policy', '--out']) expect(help.stdout).toContain(option);
    });

    it('writes the alerting-as-code layout', async () => {
        const run = await importSynthetic(RULES, policy(''));
        try {
            expect(run.files).toEqual(
                expect.arrayContaining([
                    'notification-routes/notification-routes.yml',
                    'ROUTING-FIXES.md',
                    'IMPORT-REPORT.md',
                    'import-summary.json',
                ]),
            );
            const rules = run.alertRules();
            expect(rules).toHaveLength(1);
            expect(rules[0].file).toBe(`alert-rules/${rules[0].doc.slug}.yml`);
            expect(run.contactPoints().length).toBe(5);
            for (const { doc } of [...rules, ...run.contactPoints()]) expectValidAlerting(doc);
            expectValidAlerting(run.routes());
            const summary = run.summary();
            expect(summary.command).toBe('grafana-alerts');
            expect(typeof summary.warnings.total).toBe('number');
            expect(run.result.stdout).toMatch(/1 alert rule/);
            expect(run.result.stdout).toMatch(/5 contact points/);
        } finally {
            await run.cleanup();
        }
    });

    it('fails with a message naming the file for bad input', async () => {
        const { dir, cleanup } = await tempDir();
        try {
            const broken = path.join(dir, 'broken.tf');
            await writeFile(broken, 'resource "grafana_rule_group" "x" {\n  name = "unterminated\n');
            const ok = path.join(dir, 'policy.tf');
            await writeFile(ok, policy(''));
            const result = await runCli([
                'import', 'grafana-alerts', '--rules', broken, '--contact-points', ok, '--policy', ok, '--out', path.join(dir, 'out'),
            ]);
            expect(result.code).not.toBe(0);
            expect(result.stdout + result.stderr).toContain('broken.tf');
            const missing = await runCli([
                'import', 'grafana-alerts', '--rules', path.join(dir, 'nope.tf'), '--contact-points', ok, '--policy', ok, '--out', path.join(dir, 'out'),
            ]);
            expect(missing.code).not.toBe(0);
            expect(missing.stdout + missing.stderr).toContain('nope.tf');
        } finally {
            await cleanup();
        }
    });
});
