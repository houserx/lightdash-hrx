/* eslint-disable */
// @ts-nocheck
// imp-alert-rule-conditions: the expression chain becomes the rule's reducer and condition:
// reduce + threshold, classic conditions, and range thresholds (within/outside range).
import { exprData, importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';

const classic = exprData(
    'B',
    `type = "classic_conditions"
        conditions = [{ evaluator = { type = "lt", params = [3] }, operator = { type = "and" }, query = { params = ["A"] }, reducer = { type = "avg", params = [] }, type = "query" }]`,
);
const range = (type) =>
    exprData('B', `type = "reduce"\n        expression = "A"\n        reducer = "min"`) +
    exprData('C', `type = "threshold"\n        expression = "B"\n        conditions = [{ evaluator = { type = "${type}", params = [0, 7200] } }]`);
const replaceNN =
    exprData('B', `type = "reduce"\n        expression = "A"\n        reducer = "sum"\n        settings = { mode = "replaceNN", replaceWithValue = 0 }`) +
    exprData('C', `type = "threshold"\n        expression = "B"\n        conditions = [{ evaluator = { type = "gt", params = [10] } }]`);

const RULES = ruleGroup('conditions', [
    rule({ name: 'Reduce last gt', data: promData('A', 'up') + reduceThreshold('A', 'gt', 75000, 'last') }),
    rule({ name: 'Reduce mean lt', data: promData('A', 'up') + reduceThreshold('A', 'lt', 0.5, 'mean') }),
    rule({ name: 'Reduce count', data: promData('A', 'up') + reduceThreshold('A', 'gt', 3, 'count') }),
    rule({ name: 'Classic avg lt', condition: 'B', data: promData('A', 'up') + classic }),
    rule({ name: 'Within range', data: promData('A', 'lag') + range('within_range') }),
    rule({ name: 'Outside range', data: promData('A', 'lag') + range('outside_range') }),
    rule({ name: 'Replace nulls', data: promData('A', 'errors') + replaceNN }),
]);

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, policy(''));
});
afterAll(() => run?.cleanup());

const byName = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);

describe('reducer and condition', () => {
    it('reads reduce and threshold', () => {
        expect(byName('Reduce last gt')).toMatchObject({ reducer: 'last', condition: { operator: '>', threshold: 75000 } });
        expect(byName('Reduce mean lt')).toMatchObject({ reducer: 'mean', condition: { operator: '<', threshold: 0.5 } });
        expect(byName('Reduce count')).toMatchObject({ reducer: 'count', condition: { operator: '>', threshold: 3 } });
    });

    it('reads classic conditions', () => {
        expect(byName('Classic avg lt')).toMatchObject({ reducer: 'mean', condition: { operator: '<', threshold: 3 } });
    });

    it('reads range thresholds', () => {
        expect(byName('Within range')).toMatchObject({ reducer: 'min', condition: { operator: 'within_range', min: 0, max: 7200 } });
        expect(byName('Outside range')).toMatchObject({ reducer: 'min', condition: { operator: 'outside_range', min: 0, max: 7200 } });
    });

    it('keeps the reducer and warns when null handling differs', () => {
        expect(byName('Replace nulls')).toMatchObject({ reducer: 'sum', condition: { operator: '>', threshold: 10 } });
        const lines = run.text('IMPORT-REPORT.md').split('\n').filter((l) => l.includes('Replace nulls'));
        expect(lines.join('\n')).toContain('replaceNN');
    });
});
