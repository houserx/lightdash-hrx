/* eslint-disable */
// @ts-nocheck
// imp-routing-default-only-rules: rules whose labels reach only the default route are listed in
// ROUTING-FIXES.md. When a rule names a team that has a route but lacks that route's other
// equality labels (pg_cron's team=engineering without channel=#alerts), the fix adds the missing
// labels to the rule. A team with no route gets a team route when --routing-decisions names its
// contact point, and is listed as needing a decision otherwise.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { child, importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { routeAlert, tempDir } from './support';

const r = (name, labels) => rule({ name, data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), labels, annotations: { summary: name } });
const RULES = ruleGroup('rules', [
    r('pg_cron Job Failures', { app: 'platform', team: 'engineering' }),
    r('Support queue stuck', { team: 'Support' }),
    r('Unlabelled rule', { environment: 'prod' }),
    r('Routed rule', { team: 'infra' }),
]);
const POLICY = policy(
    child({ matchers: [['team', '=', 'engineering'], ['channel', '=', '#alerts']], contactPoint: 'slack-alerts', cont: true }) +
        child({ matchers: [['team', '=', 'infra']], contactPoint: 'pager', cont: true }),
);

let undecided: any;
let decided: any;
let tmp: any;
beforeAll(async () => {
    tmp = await tempDir();
    const decisions = path.join(tmp.dir, 'routing-decisions.yml');
    await writeFile(decisions, 'teams:\n  Support: slack-platform\n');
    undecided = await importSynthetic(RULES, POLICY);
    decided = await importSynthetic(RULES, POLICY, ['--routing-decisions', decisions]);
});
afterAll(async () => {
    await undecided?.cleanup();
    await decided?.cleanup();
    await tmp?.cleanup();
});

const slug = (run, name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;
const ruleIn = (run, name) => run.alertRules().map((x) => x.doc).find((d) => d.name === name);
const routed = (run, name) => {
    const doc = ruleIn(run, name);
    return routeAlert(run.routes(), { ...doc.labels, alertname: doc.name }).map((x) => x.contactPoint);
};

describe('rules that reach only the default route', () => {
    it('lists them', () => {
        const md = undecided.text('ROUTING-FIXES.md');
        expect(md).toMatch(/default route only/i);
        for (const name of ['pg_cron Job Failures', 'Support queue stuck', 'Unlabelled rule']) expect(md).toContain(name);
        expect(md).not.toContain('Routed rule');
    });

    it('adds the labels a team route needs', () => {
        const doc = ruleIn(undecided, 'pg_cron Job Failures');
        expect(doc.labels).toMatchObject({ team: 'engineering', channel: '#alerts', app: 'platform' });
        expect(routed(undecided, 'pg_cron Job Failures')).toEqual([slug(undecided, 'slack-alerts')]);
        expect(undecided.text('ROUTING-FIXES.md')).toContain('channel = #alerts');
    });

    it('routes a decided team and flags an undecided one', () => {
        expect(routed(undecided, 'Support queue stuck')).toEqual([slug(undecided, 'slack-infra-alerts')]);
        expect(undecided.summary().warnings.byCode['routing-needs-decision']).toBeGreaterThanOrEqual(1);
        expect(routed(decided, 'Support queue stuck')).toContain(slug(decided, 'slack-platform'));
        // Rules nothing can be inferred for stay on the default route.
        expect(routed(decided, 'Unlabelled rule')).toEqual([slug(decided, 'slack-infra-alerts')]);
        expect(routed(decided, 'Routed rule')).toEqual([slug(decided, 'pager')]);
    });
});
