/* eslint-disable */
// @ts-nocheck
// imp-alert-contact-points: Grafana contact points become contact_point documents. Slack
// webhooks and incident.io credentials become secret references, never values.
import path from 'node:path';
import { importFixtureAlerts, expectValidAlerting, generateSlug } from './support';

let run: any;
beforeAll(async () => {
    run = await importFixtureAlerts();
});
afterAll(() => run?.cleanup());

const byName = (name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name);

describe('contact points', () => {
    it('converts all six contact points, valid', () => {
        const names = run.contactPoints().map((c) => c.doc.name).sort();
        expect(names).toEqual(
            ['Grafana Alerts (incident.io)', 'slack-alerts', 'slack-alerts-swat', 'slack-infra-alerts', 'slack-sec', 'test-alerts'].sort(),
        );
        for (const { doc, file } of run.contactPoints()) {
            expectValidAlerting(doc);
            expect(file).toBe(`contact-points/${doc.slug}.yml`);
        }
    });

    it('turns Slack webhooks into secret references', () => {
        const infra = byName('slack-infra-alerts');
        expect(infra.slug).toBe(generateSlug('slack-infra-alerts'));
        expect(infra.integrations).toEqual([
            {
                type: 'slack_webhook',
                url: { secretRef: `${infra.slug}-webhook` },
                title: '{{ template "slack.title" . }}',
                text: '{{ template "slack.message" . }}',
                disableResolveMessage: false,
            },
        ]);
        expect(byName('slack-alerts').integrations[0].disableResolveMessage).toBe(true);
        expect(byName('test-alerts').integrations[0].title).toBe('{{ template "test.slack.title" . }}');
    });

    it('turns the incident.io webhook into an incident_io integration with a token reference', () => {
        const incident = byName('Grafana Alerts (incident.io)');
        expect(incident.integrations).toHaveLength(1);
        const [integration] = incident.integrations;
        expect(integration.type).toBe('incident_io');
        expect(integration.url).toBe('https://api.incident.io/v2/alert_events/http/test-alert-source-not-real');
        expect(typeof integration.token.secretRef).toBe('string');
        expect(integration.token.secretRef.length).toBeGreaterThan(0);
    });

    it('writes no secret material anywhere', () => {
        for (const file of run.files) {
            const text = run.text(file);
            expect(text).not.toMatch(/hooks\.slack\.com/);
            expect(text).not.toMatch(/secret_string/);
            expect(text).not.toMatch(/local\.(grafana_|slack_webhooks)/);
        }
    });
});
