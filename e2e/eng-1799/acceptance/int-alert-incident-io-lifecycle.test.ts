/* eslint-disable */
// @ts-nocheck
// int-alert-incident-io-lifecycle: the fake Prometheus is driven through firing and resolving; the
// Alert Rule evaluated through the real engine notifies a fake incident.io receiver with
// Alertmanager webhook v4 payloads (firing, then resolved with endsAt), authorised with the
// Contact Point's secret, and the configured heartbeat URL is called after every cycle.
import { RULE_SQL } from './fixtures';
import { disposeAll, harness, ld, nextSlot, track, waitFor } from './support';

afterAll(disposeAll);

const INCIDENT_TOKEN = 'test-incident-token-not-real';

describe('int-alert-incident-io-lifecycle', () => {
    it('fires, resolves, notifies incident.io and beats the heartbeat', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'db_cpu', instance: 'db-1' }, value: 95 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const incident = track(await h.startRecorder());
        const heartbeat = track(await h.startRecorder());
        const lightdash = track(
            await h.startLightdash({
                engine,
                env: {
                    ALERTING_SECRET_INCIDENT_IO_E2E: INCIDENT_TOKEN,
                    ALERTING_HEARTBEAT_URL: `${heartbeat.url}/beat`,
                    ALERTING_HEARTBEAT_METHOD: 'GET',
                },
            }),
        );
        const base = `/api/v2/projects/${lightdash.projectUuid}/alerting`;

        const contact = await ld(lightdash, 'POST', `${base}/contact-points`, {
            name: 'incident-io-e2e',
            integrations: [{ type: 'incident_io', url: `${incident.url}/v2/alert_events/alertmanager/e2e`, token: { secretRef: 'incident-io-e2e' } }],
        });
        expect(contact.status, contact.text).toBe(200);
        const routes = await ld(lightdash, 'PUT', `${base}/notification-routes`, {
            contactPoint: contact.json.results.slug,
            groupBy: ['alertname'],
            groupWait: '1s',
            groupInterval: '1s',
            repeatInterval: '4h',
            routes: [],
        });
        expect(routes.status, routes.text).toBe(200);
        const rule = await ld(lightdash, 'POST', `${base}/rules`, {
            name: 'Synthetic DB CPU high',
            description: 'Synthetic database CPU above 90%',
            query: RULE_SQL(),
            reducer: 'last',
            condition: { operator: '>', threshold: 90 },
            for: '0s',
            interval: '30s',
            timeRange: '5m',
            labels: { team: 'infra' },
            annotations: { summary: '{{ $labels.instance }} CPU is {{ $value }}' },
        });
        expect(rule.status, rule.text).toBe(200);

        await lightdash.runAlertingCycle();
        await new Promise((r) => setTimeout(r, 1_500));
        await lightdash.runAlertingCycle();
        const firing = await waitFor('a firing notification', async () => incident.requests.find((r) => r.json?.status === 'firing'), 20_000);
        expect(firing.method).toBe('POST');
        expect(firing.path).toBe('/v2/alert_events/alertmanager/e2e');
        expect(firing.headers.authorization).toBe(`Bearer ${INCIDENT_TOKEN}`);
        expect(firing.json.version).toBe('4');
        expect(firing.json.alerts).toHaveLength(1);
        const alert = firing.json.alerts[0];
        expect(alert.status).toBe('firing');
        expect(alert.labels).toMatchObject({ alertname: 'Synthetic DB CPU high', instance: 'db-1', team: 'infra' });
        expect(alert.annotations.summary).toBe('db-1 CPU is 95');
        expect(alert.endsAt).toBe('0001-01-01T00:00:00Z');
        expect(Number.isNaN(Date.parse(alert.startsAt))).toBe(false);
        expect(alert.fingerprint).toMatch(/^[0-9a-f]{16}$/);

        prom.setSeries([{ labels: { __name__: 'db_cpu', instance: 'db-1' }, value: 20 }]);
        await nextSlot(30);
        await lightdash.runAlertingCycle();
        await new Promise((r) => setTimeout(r, 1_500));
        await lightdash.runAlertingCycle();
        const resolved = await waitFor('a resolved notification', async () => incident.requests.find((r) => r.json?.status === 'resolved'), 20_000);
        const done = resolved.json.alerts[0];
        expect(done.status).toBe('resolved');
        expect(done.fingerprint).toBe(alert.fingerprint);
        expect(Date.parse(done.endsAt)).toBeGreaterThanOrEqual(Date.parse(done.startsAt));
        expect(incident.requests.filter((r) => r.json?.status === 'firing')).toHaveLength(1);

        const beats = heartbeat.requests.filter((r) => r.path === '/beat');
        expect(beats.length).toBeGreaterThanOrEqual(4);
        expect(beats.every((r) => r.method === 'GET')).toBe(true);
    });
});
