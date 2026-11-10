/* eslint-disable */
// @ts-nocheck
// int-alert-engine-down: when the Federation Engine is down, an Alert Rule's evaluation follows
// its errorState: the rule shows state error with a DatasourceError instance naming the failure,
// the transition is in the history, and a DatasourceError notification goes out.
import { RULE_SQL } from './fixtures';
import { disposeAll, harness, ld, track, waitFor } from './support';

afterAll(disposeAll);

describe('int-alert-engine-down', () => {
    it('engine down gives error / DatasourceError', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'db_cpu', instance: 'db-1' }, value: 5 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const receiver = track(await h.startRecorder());
        const lightdash = track(await h.startLightdash({ engine }));
        const base = `/api/v2/projects/${lightdash.projectUuid}/alerting`;

        const contact = await ld(lightdash, 'POST', `${base}/contact-points`, { name: 'webhook-e2e', integrations: [{ type: 'webhook', url: `${receiver.url}/hook` }] });
        expect(contact.status, contact.text).toBe(200);
        await ld(lightdash, 'PUT', `${base}/notification-routes`, { contactPoint: contact.json.results.slug, groupBy: ['alertname'], groupWait: '1s', groupInterval: '1s', repeatInterval: '4h', routes: [] });
        const created = await ld(lightdash, 'POST', `${base}/rules`, {
            name: 'Synthetic DB CPU while engine down',
            description: 'Synthetic CPU rule for the engine-down check',
            query: RULE_SQL(),
            condition: { operator: '>', threshold: 90 },
            for: '0s',
            interval: '30s',
            timeRange: '5m',
        });
        const ruleUuid = created.json.results.uuid;

        await engine.stop();
        await lightdash.runAlertingCycle();
        await new Promise((r) => setTimeout(r, 1_500));
        await lightdash.runAlertingCycle();

        const rule = await ld(lightdash, 'GET', `${base}/rules/${ruleUuid}`);
        expect(rule.json.results.state).toBe('error');
        const instance = rule.json.results.instances.find((i) => i.labels.alertname === 'DatasourceError');
        expect(instance).toBeDefined();
        expect(instance.state).toBe('error');
        expect(instance.annotations.error).toBeTruthy();

        const history = await ld(lightdash, 'GET', `${base}/history?rule=${ruleUuid}`);
        expect(history.json.results.some((e) => e.type === 'transition' && e.state === 'error')).toBe(true);

        const sent = await waitFor('a DatasourceError notification', async () => receiver.requests.find((r) => r.json?.alerts?.some((a) => a.labels.alertname === 'DatasourceError')), 20_000);
        expect(sent.json.version).toBe('4');
    });
});
