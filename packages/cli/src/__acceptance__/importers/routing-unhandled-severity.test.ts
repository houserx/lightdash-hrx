/* eslint-disable */
// @ts-nocheck
// imp-routing-unhandled-severity: severity label values that rules carry but no route matches
// are listed in ROUTING-FIXES.md. Where --routing-decisions names a contact point for a value,
// a severity route (continue: true, ahead of the others) is added; otherwise the value is listed
// as needing a decision with a routing-needs-decision warning.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { child, importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { routeAlert, tempDir } from './support';

const r = (name, labels) => rule({ name, data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), labels, annotations: { summary: name } });
const RULES = ruleGroup('rules', [
    r('Critical rule', { team: 'infra', severity: 'critical' }),
    r('Sev one rule', { team: 'web', severity: '1' }),
    r('Low rule', { severity: 'low' }),
]);
const POLICY = policy(
    child({ matchers: [['severity', '=', 'critical']], contactPoint: 'pager', cont: true }) +
        child({ matchers: [['team', '=', 'infra']], contactPoint: 'slack-alerts' }),
);

let undecided: any;
let decided: any;
let tmp: any;
beforeAll(async () => {
    tmp = await tempDir();
    const decisions = path.join(tmp.dir, 'routing-decisions.yml');
    await writeFile(decisions, 'severities:\n  "1": pager\n');
    undecided = await importSynthetic(RULES, POLICY);
    decided = await importSynthetic(RULES, POLICY, ['--routing-decisions', decisions]);
});
afterAll(async () => {
    await undecided?.cleanup();
    await decided?.cleanup();
    await tmp?.cleanup();
});

const slug = (run, name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;
const routedIn = (run, labels) => routeAlert(run.routes(), labels).map((x) => x.contactPoint);

describe('unhandled severities', () => {
    it('lists the severity values no route handles', () => {
        const md = undecided.text('ROUTING-FIXES.md');
        expect(md).toMatch(/severity/i);
        expect(md).toContain('severity = 1');
        expect(md).toContain('severity = low');
        expect(undecided.summary().warnings.byCode['routing-needs-decision']).toBeGreaterThanOrEqual(2);
    });

    it('adds a severity route for a decided value', () => {
        expect(routedIn(undecided, { team: 'web', severity: '1' })).toEqual([slug(undecided, 'slack-infra-alerts')]);
        expect(routedIn(decided, { team: 'web', severity: '1' })).toContain(slug(decided, 'pager'));
        // continue: true, so team routing still applies after it.
        expect(routedIn(decided, { team: 'infra', severity: '1' })).toEqual(
            expect.arrayContaining([slug(decided, 'pager'), slug(decided, 'slack-alerts')]),
        );
        expect(decided.text('ROUTING-FIXES.md')).toContain('severity = 1');
    });
});
