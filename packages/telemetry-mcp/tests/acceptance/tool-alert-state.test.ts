import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_UUID, SERVICE_TOKEN, startHarness, type Harness } from './helpers/harness';

const STATE = [
    {
        ruleUuid: 'a1a1a1a1-0000-4000-8000-000000000001',
        name: 'API 5xx rate high',
        state: 'firing',
        series: [{ labels: { job: 'api' }, state: 'firing', since: '2026-11-08T10:00:00Z', value: 0.12 }],
    },
    { ruleUuid: 'a1a1a1a1-0000-4000-8000-000000000002', name: 'Queue depth', state: 'normal', series: [] },
];

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.lightdash.setAlerting(PROJECT_UUID, 'state', STATE);
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const alertingCalls = () => h.lightdash.requests.filter((r) => r.path.includes('/alerting/'));

describe('alert_state', () => {
    it('returns the Operations Project alert state from GET /api/v2/projects/{uuid}/alerting/state', async () => {
        const r = await h.call('alert_state', {});
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.results).toEqual(STATE);
        const call = alertingCalls().at(-1)!;
        expect(call.method).toBe('GET');
        expect(call.path).toBe(`/api/v2/projects/${PROJECT_UUID}/alerting/state`);
        expect(call.headers.authorization).toBe(`ApiKey ${SERVICE_TOKEN}`);
    });

    it('filters to one Alert Rule with rule_uuid (sent as ruleUuid)', async () => {
        const r = await h.call('alert_state', { rule_uuid: 'a1a1a1a1-0000-4000-8000-000000000001' });
        expect(r.isError, r.text).toBe(false);
        expect(alertingCalls().at(-1)!.query.ruleUuid).toBe('a1a1a1a1-0000-4000-8000-000000000001');
    });

    it('rejects a rule_uuid that is not a uuid, without calling Lightdash', async () => {
        const before = alertingCalls().length;
        const r = await h.call('alert_state', { rule_uuid: '../../admin' });
        expect(r.isError).toBe(true);
        expect(alertingCalls().length).toBe(before);
    });

    it('turns a Lightdash error into a tool error', async () => {
        h.lightdash.failAlerting(503, 'alerting evaluator unavailable');
        const r = await h.call('alert_state', {});
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/503|unavailable/i);
        expect(r.text).not.toContain(SERVICE_TOKEN);
    });
});
