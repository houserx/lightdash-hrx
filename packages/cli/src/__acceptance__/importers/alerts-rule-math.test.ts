/* eslint-disable */
// @ts-nocheck
// imp-alert-rule-math: math expressions over several queries become one SQL query over the
// translated inputs; a rule whose expressions can't be translated is still emitted (valid,
// shadow, paused) with a rule-needs-review warning, never dropped.
import { exprData, importSynthetic, policy, promData, rule, ruleGroup } from './alertsupport';
import { calls, codeOutsideLiterals, expectValidAlerting } from './support';

const math =
    promData('A', 'sum(rate(http_requests_total{code=~"5.."}[5m]))') +
    promData('B', 'sum(rate(http_requests_total[5m]))') +
    exprData('C', 'type = "math"\n        expression = "$A / $B * 100"') +
    exprData('D', 'type = "reduce"\n        expression = "C"\n        reducer = "last"') +
    exprData('E', 'type = "threshold"\n        expression = "D"\n        conditions = [{ evaluator = { type = "gt", params = [5] } }]');
const resample =
    promData('A', 'up') +
    exprData('B', 'type = "resample"\n        expression = "A"\n        window = "1m"\n        downsampler = "mean"\n        upsampler = "fillna"') +
    exprData('C', 'type = "threshold"\n        expression = "B"\n        conditions = [{ evaluator = { type = "lt", params = [1] } }]');

const RULES = ruleGroup('math', [
    rule({ name: 'Error percentage', condition: 'E', data: math, annotations: { summary: 'Over 5% of requests fail' } }),
    rule({ name: 'Resampled', data: resample, annotations: { summary: 'Resampled up' } }),
]);

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, policy(''));
});
afterAll(() => run?.cleanup());

const byName = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);

describe('math and untranslatable expressions', () => {
    it('evaluates math over both queries in SQL', () => {
        const doc = byName('Error percentage');
        expect(calls(doc.query, 'promql').length + calls(doc.query, 'promql_instant').length).toBe(2);
        const code = codeOutsideLiterals(doc.query);
        expect(code).toContain('/');
        expect(code).toContain('100');
        expect(doc).toMatchObject({ reducer: 'last', condition: { operator: '>', threshold: 5 }, paused: false });
    });

    it('keeps a rule it cannot translate, paused, with a warning', () => {
        const doc = byName('Resampled');
        expectValidAlerting(doc);
        expect(doc.paused).toBe(true);
        expect(doc.shadow).toBe(true);
        expect(run.summary().warnings.byCode['rule-needs-review']).toBe(1);
        const lines = run.text('IMPORT-REPORT.md').split('\n').filter((l) => l.includes('Resampled'));
        expect(lines.join('\n')).toContain('resample');
    });
});
