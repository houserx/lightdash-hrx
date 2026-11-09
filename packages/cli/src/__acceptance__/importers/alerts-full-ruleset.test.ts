/* eslint-disable */
// @ts-nocheck
// imp-alerts-full-ruleset: importing today's full Grafana rule set (every grafana_rule_group in
// the fixtures, with for_each and dynamic blocks expanded) emits one valid alert_rule per rule
// instance with no crash: about 85 rules, unique slugs, all in shadow mode.
import { expectValidAlerting, importFixtureAlerts } from './support';

let run: any;
beforeAll(async () => {
    run = await importFixtureAlerts();
});
afterAll(() => run?.cleanup());

const docs = () => run.alertRules().map((r) => r.doc);

describe('the full rule set', () => {
    it('emits every rule instance once', () => {
        // Counted by hand from the fixtures: 2 auth0, 7 envoy and 7 spire (staging only),
        // 30 k8s (5x3 pod + 2 orphan sweep + 3x3 node + 4 single), 2 WAF, 9 PA renewal,
        // 3 platform, 2 pg_cron + 11 RDS health, 4 synthetic, 8 ALB = 85.
        expect(docs().length).toBeGreaterThanOrEqual(80);
        expect(docs().length).toBeLessThanOrEqual(90);
        expect(new Set(docs().map((d) => d.slug)).size).toBe(docs().length);
        expect(run.result.stdout).toContain(`${docs().length} alert rules`);
    });

    it('expands per-environment groups', () => {
        const alb = docs().filter((d) => d.name.startsWith('ALB Unhealthy Hosts'));
        expect(alb).toHaveLength(2);
        expect(new Set(alb.map((d) => `${d.spaceSlug} ${JSON.stringify(d.labels)} ${d.name}`)).size).toBe(2);
        expect(docs().filter((d) => d.name.startsWith('Orphan'))).toHaveLength(2);
        expect(docs().filter((d) => /RDS - /.test(d.name))).toHaveLength(11);
        expect(docs().filter((d) => d.name.includes('Envoy') && d.name.includes('prod'))).toHaveLength(0);
    });

    it('emits only valid shadow rules with descriptions', () => {
        for (const doc of docs()) {
            expectValidAlerting(doc);
            expect(doc.shadow).toBe(true);
            expect(doc.description.trim().length).toBeGreaterThan(0);
            expect(doc.query.trim().length).toBeGreaterThan(0);
        }
    });
});
