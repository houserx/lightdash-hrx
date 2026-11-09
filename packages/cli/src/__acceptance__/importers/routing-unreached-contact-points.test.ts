/* eslint-disable */
// @ts-nocheck
// imp-routing-unreached-contact-points: a contact point that no route (and no rule's
// notification_settings) reaches is listed in ROUTING-FIXES.md; the fix adds a
// notify=<contact point slug> route for it, so a rule can opt in with that label.
import { child, importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { routeAlert } from './support';

const RULES = ruleGroup('rules', [
    rule({ name: 'Infra rule', data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), labels: { team: 'infra' }, annotations: { summary: 'infra' } }),
]);
const POLICY = policy(child({ matchers: [['team', '=', 'infra']], contactPoint: 'pager', cont: true }));

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, POLICY);
});
afterAll(() => run?.cleanup());

const slug = (name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;

describe('unreached contact points', () => {
    it('lists every contact point no route reaches', () => {
        const md = run.text('ROUTING-FIXES.md');
        expect(md).toMatch(/unreached contact point/i);
        for (const name of ['slack-alerts', 'slack-platform', 'slack-sec']) expect(md).toContain(slug(name));
        // The default route's and the infra route's contact points are reached.
        expect(md).not.toMatch(new RegExp(`unreached[^\\n]*\\b${slug('pager')}\\b`, 'i'));
    });

    it('adds a notify route for each, so rules can opt in', () => {
        for (const name of ['slack-alerts', 'slack-platform', 'slack-sec']) {
            const routed = routeAlert(run.routes(), { notify: slug(name) }).map((r) => r.contactPoint);
            expect(routed).toContain(slug(name));
        }
        // An alert without the label routes as before.
        expect(routeAlert(run.routes(), { team: 'infra' }).map((r) => r.contactPoint)).toEqual([slug('pager')]);
    });
});
