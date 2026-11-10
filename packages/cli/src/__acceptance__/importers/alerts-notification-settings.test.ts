/* eslint-disable */
// @ts-nocheck
// imp-alert-notification-settings: a rule with notification_settings { contact_point } (Grafana
// simplified routing) still reaches that contact point, and only it: the rule gets the label
// notify=<contact point slug>, and the tree a matching `notify` route ahead of the policies.
import { importSynthetic, policy, child, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { routeAlert } from './support';

const RULES = ruleGroup('simplified', [
    rule({
        name: 'Direct to Slack',
        data: promData('A', 'up') + reduceThreshold('A', 'lt', 1),
        labels: { team: 'infra' },
        annotations: { summary: 'direct' },
        extra: 'notification_settings {\n      contact_point = grafana_contact_point.slack-platform.name\n    }',
    }),
    rule({
        name: 'Direct by name',
        data: promData('A', 'up') + reduceThreshold('A', 'lt', 1),
        annotations: { summary: 'by name' },
        extra: 'notification_settings {\n      contact_point = "pager"\n    }',
    }),
    rule({ name: 'Policy routed', data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), labels: { team: 'infra' }, annotations: { summary: 'policy' } }),
]);
const POLICY = policy(child({ matchers: [['team', '=', 'infra']], contactPoint: 'pager' }));

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, POLICY, ['--no-routing-fixes']);
});
afterAll(() => run?.cleanup());

const rule_ = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);
const slugOf = (name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;
const routed = (doc) => routeAlert(run.routes(), { ...doc.labels, alertname: doc.name }).map((r) => r.contactPoint);

describe('notification_settings', () => {
    it('labels the rule and routes it to its contact point only', () => {
        const direct = rule_('Direct to Slack');
        expect(direct.labels.notify).toBe(slugOf('slack-platform'));
        expect(routed(direct)).toEqual([slugOf('slack-platform')]);
        expect(routed(rule_('Direct by name'))).toEqual([slugOf('pager')]);
    });

    it('leaves policy-routed rules alone', () => {
        expect(rule_('Policy routed').labels.notify).toBeUndefined();
        expect(routed(rule_('Policy routed'))).toEqual([slugOf('pager')]);
    });
});
