/* eslint-disable */
// @ts-nocheck
// imp-alert-rule-description: the rule description (the audit description of every query the
// rule runs) comes from the summary annotation; when a rule has none, one is generated from the
// title and the query, and flagged with rule-description-generated.
import { importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';

const RULES = ruleGroup('descriptions', [
    rule({
        name: 'Has summary',
        data: promData('A', 'up{job="api"}') + reduceThreshold('A', 'lt', 1),
        annotations: { summary: 'Auth0 M2M token daily limit exceeded for {{ $labels.client_name }}', description: 'Longer text.' },
    }),
    rule({ name: 'No summary at all', data: promData('A', 'kube_job_failed{namespace="sweep"}') + reduceThreshold('A', 'gt', 0) }),
    rule({ name: 'Blank summary', data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), annotations: { summary: '   ' } }),
]);

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, policy(''));
});
afterAll(() => run?.cleanup());

const byName = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);

describe('rule descriptions', () => {
    it('uses the summary annotation', () => {
        expect(byName('Has summary').description).toBe('Auth0 M2M token daily limit exceeded for {{ $labels.client_name }}');
    });

    it('generates one from the title and query when missing, and flags it', () => {
        const generated = byName('No summary at all').description;
        expect(generated).toContain('No summary at all');
        expect(generated).toContain('kube_job_failed');
        expect(byName('Blank summary').description.trim().length).toBeGreaterThan(0);
        expect(run.summary().warnings.byCode['rule-description-generated']).toBe(2);
        const report = run.text('IMPORT-REPORT.md');
        expect(report).toContain('No summary at all');
        expect(report).toContain('Blank summary');
    });
});
