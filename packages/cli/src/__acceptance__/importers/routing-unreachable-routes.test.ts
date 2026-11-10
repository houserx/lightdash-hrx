/* eslint-disable */
// @ts-nocheck
// imp-routing-unreachable-routes: a route that can never match a rule because an earlier sibling
// without `continue` catches its alerts first (matcher order, or a missing continue) is a
// routing defect: ROUTING-FIXES.md lists it with the proposed fix, and the fix is applied in the
// output tree so the route's rules reach it.
import { child, importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { routeAlert } from './support';

const r = (name, labels) => rule({ name, data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), labels, annotations: { summary: name } });
const RULES = ruleGroup('rules', [
    r('Platform rule', { team: 'platform' }),
    r('Infra critical rule', { team: 'infra', severity: 'critical' }),
    r('Infra rule', { team: 'infra' }),
]);
const POLICY = policy(
    // Matcher order: the regex route catches team=platform before the exact route below it.
    child({ matchers: [['team', '=~', 'infra|platform']], contactPoint: 'pager' }) +
        child({ matchers: [['team', '=', 'platform']], contactPoint: 'slack-platform' }) +
        // Missing continue: severity=critical alerts of team=infra never reach this route.
        child({ matchers: [['severity', '=', 'critical']], contactPoint: 'slack-alerts' }),
);

let fixed: any;
let unfixed: any;
beforeAll(async () => {
    fixed = await importSynthetic(RULES, POLICY);
    unfixed = await importSynthetic(RULES, POLICY, ['--no-routing-fixes']);
});
afterAll(async () => {
    await fixed?.cleanup();
    await unfixed?.cleanup();
});

const routedIn = (run, labels) => routeAlert(run.routes(), labels).map((x) => x.contactPoint);
const slug = (run, name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;

describe('unreachable routes', () => {
    it('reproduces the defect without fixes', () => {
        expect(routedIn(unfixed, { team: 'platform' })).toEqual([slug(unfixed, 'pager')]);
        expect(routedIn(unfixed, { team: 'infra', severity: 'critical' })).toEqual([slug(unfixed, 'pager')]);
    });

    it('lists each unreachable route with its fix', () => {
        const md = fixed.text('ROUTING-FIXES.md');
        expect(md).toMatch(/unreachable route/i);
        expect(md).toContain('team = platform');
        expect(md).toContain('severity = critical');
        expect(md).toContain('Platform rule');
        expect(md).toContain('Infra critical rule');
    });

    it('applies the fix so the rules reach the route', () => {
        expect(routedIn(fixed, { team: 'platform' })).toContain(slug(fixed, 'slack-platform'));
        const critical = routedIn(fixed, { team: 'infra', severity: 'critical' });
        expect(critical).toContain(slug(fixed, 'slack-alerts'));
        expect(critical).toContain(slug(fixed, 'pager'));
        // Alerts the defect didn't touch still go where they went.
        expect(routedIn(fixed, { team: 'infra' })).toEqual([slug(fixed, 'pager')]);
    });
});
