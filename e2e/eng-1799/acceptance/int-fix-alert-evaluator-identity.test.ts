/* eslint-disable */
// @ts-nocheck
// int-fix-alert-evaluator-identity: the alert evaluator queries the engine as the system identity
// (CONTRACTS §4.3): sub system:alert-evaluator, sys true, the attrs configured for it
// (ALERTING_EVALUATOR_ATTRS), the rule's description as audit.description and source alert_rule.
// A rule over Restricted Telemetry is therefore evaluated, and its audit record lands in the fake
// audit store as an assertion with the rule's description.
import { RULE_SQL } from './fixtures';
import { disposeAll, harness, ld, track } from './support';

afterAll(disposeAll);

describe('int-fix-alert-evaluator-identity', () => {
    it('evaluates a Restricted Telemetry rule as system:alert-evaluator, audited', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'phi_queue_depth', queue: 'q-1' }, value: 500 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const lightdash = track(await h.startLightdash({ engine, env: { ALERTING_EVALUATOR_ATTRS: 'telemetry_restricted' } }));
        const base = `/api/v2/projects/${lightdash.projectUuid}/alerting`;

        const created = await ld(lightdash, 'POST', `${base}/rules`, {
            name: 'Synthetic restricted queue depth',
            description: 'Restricted queue depth above 100 for the synthetic queue',
            query: RULE_SQL('phi_queue_depth', 'prometheus-restricted'),
            reducer: 'last',
            condition: { operator: '>', threshold: 100 },
            for: '0s',
            interval: '30s',
            timeRange: '5m',
        });
        expect(created.status, created.text).toBe(200);
        const ruleUuid = created.json.results.uuid;

        await lightdash.runAlertingCycle();

        const rule = await ld(lightdash, 'GET', `${base}/rules/${ruleUuid}`);
        expect(rule.json.results.state).toBe('firing');

        const items = engine.auditStore.items().filter((i) => i.database === 'prometheus-restricted');
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items[0]).toMatchObject({
            executedBySub: 'system:alert-evaluator',
            description: 'Restricted queue depth above 100 for the synthetic queue',
            action: 'assertion',
            mode: 'read',
            status: 'success',
        });
    });

    it('without the configured attrs the restricted rule errors instead of reading', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'phi_queue_depth', queue: 'q-1' }, value: 500 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const lightdash = track(await h.startLightdash({ engine, env: { ALERTING_EVALUATOR_ATTRS: '' } }));
        const base = `/api/v2/projects/${lightdash.projectUuid}/alerting`;
        const created = await ld(lightdash, 'POST', `${base}/rules`, {
            name: 'Synthetic restricted without attrs',
            description: 'Restricted read without the claim',
            query: RULE_SQL('phi_queue_depth', 'prometheus-restricted'),
            condition: { operator: '>', threshold: 100 },
            interval: '30s',
            timeRange: '5m',
        });
        await lightdash.runAlertingCycle();
        const rule = await ld(lightdash, 'GET', `${base}/rules/${created.json.results.uuid}`);
        expect(rule.json.results.state).toBe('error');
        const instance = rule.json.results.instances.find((i) => i.labels.alertname === 'DatasourceError');
        expect(instance.annotations.error).toContain('telemetry_restricted');
        expect(engine.auditStore.items()).toHaveLength(0);
    });
});
