/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Docs and the as-code port of today's Grafana contact points and routing.
import { readdirSync, readFileSync, statSync } from 'fs';
import * as yaml from 'js-yaml';
import path from 'path';
import { describe, expect, it } from 'vitest';

const common = async () => (await import('../../index')) as Record<string, any>;
const repoRoot = path.resolve(__dirname, '../../../../..');
const docsDir = path.join(repoRoot, 'docs/eng-1799');

describe('alert-docs', () => {
    it('documents the model, routing semantics, the Shadow Run and Cutover', () => {
        const doc = readFileSync(path.join(docsDir, 'alerting.md'), 'utf8');
        for (const heading of [
            /^## Model/m,
            /^## Routing semantics/m,
            /^## Shadow Run/m,
            /^## Cutover/m,
        ])
            expect(doc).toMatch(heading);
        for (const term of [
            'Alert Rule',
            'Contact Point',
            'Notification Route',
            'Managed',
            'secretRef',
            'noDataState',
            'keepFiringFor',
            'continue',
            'groupWait',
            'repeatInterval',
            'lightdash alerting shadow-report',
            'lightdash upload --alerting-only',
            '/api/v1/alerting/health',
            'system:alert-evaluator',
        ])
            expect(doc, term).toContain(term);
        expect(doc).not.toMatch(
            /\b(dry run|parallel run|go-live|switchover|canary)\b/i,
        );
    });
});

const ymlFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
        const full = path.join(dir, n);
        return statSync(full).isDirectory()
            ? ymlFiles(full)
            : /\.ya?ml$/.test(n)
              ? [full]
              : [];
    });

describe('alert-grafana-port-examples', () => {
    it("ports today's six contact points and routing tree as valid alerting code", async () => {
        const { validateAlertingAsCode, routeAlert } = await common();
        const dir = path.join(docsDir, 'alerting-examples');
        const docs = ymlFiles(dir).map((f) => ({
            f,
            d: yaml.load(readFileSync(f, 'utf8')) as any,
        }));
        for (const { f, d } of docs)
            expect(validateAlertingAsCode(d), f).toEqual({
                valid: true,
                errors: [],
            });
        const cps = docs
            .filter(({ d }) => d.type === 'contact_point')
            .map(({ d }) => d);
        expect(cps.map((c) => c.slug).sort()).toEqual(
            [
                'incident-io',
                'slack-alerts',
                'slack-alerts-swat',
                'slack-infra-alerts',
                'slack-sec',
                'test-alerts',
            ].sort(),
        );
        const incident = cps.find((c) => c.slug === 'incident-io');
        expect(incident.integrations[0]).toMatchObject({
            type: 'incident_io',
            token: { secretRef: expect.any(String) },
        });
        const alertsChannel = cps.find((c) => c.slug === 'slack-alerts');
        expect(alertsChannel.integrations[0]).toMatchObject({
            type: 'slack_webhook',
            disableResolveMessage: true,
        });
        const trees = docs
            .filter(({ d }) => d.type === 'notification_routes')
            .map(({ d }) => d);
        expect(trees).toHaveLength(1);
        const cp = (labels: Record<string, string>) =>
            routeAlert(trees[0], labels).map((r: any) => r.contactPoint);
        expect(cp({ team: 'infra' })).toContain('incident-io');
        expect(cp({ team: 'test' })).toContain('test-alerts');
        expect(cp({ team: 'swat' })).toContain('slack-alerts-swat');
        expect(cp({ team: 'engineering', channel: '#alerts' })).toContain(
            'slack-alerts',
        );
        expect(cp({ system: 'platform-environment-sweep' })).toEqual([
            'slack-infra-alerts',
        ]);
        expect(cp({ team: 'nobody' })).toEqual(['slack-infra-alerts']);
        expect(routeAlert(trees[0], { team: 'infra' })[0]).toMatchObject({
            groupWait: '5s',
            groupInterval: '2m',
            repeatInterval: '1d',
        });
        const rules = docs.filter(({ d }) => d.type === 'alert_rule');
        expect(rules.length).toBeGreaterThanOrEqual(3);
        expect(rules.every(({ d }) => d.shadow === true)).toBe(true);
    });
});
