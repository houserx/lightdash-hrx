import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_UUID, SERVICE_TOKEN, startHarness, type Harness } from './helpers/harness';

const RULE = 'a1a1a1a1-0000-4000-8000-000000000001';
const HISTORY = [
    { ruleUuid: RULE, labels: { job: 'api' }, from: 'pending', to: 'firing', at: '2026-11-08T10:00:00Z' },
    { ruleUuid: RULE, labels: { job: 'api' }, from: 'firing', to: 'resolved', at: '2026-11-08T10:30:00Z' },
];

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.lightdash.setAlerting(PROJECT_UUID, 'history', HISTORY);
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const historyCalls = () => h.lightdash.requests.filter((r) => r.path.endsWith('/alerting/history'));

describe('alert_history', () => {
    it('returns state transitions from GET /api/v2/projects/{uuid}/alerting/history', async () => {
        const r = await h.call('alert_history', {});
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.results).toEqual(HISTORY);
        const call = historyCalls().at(-1)!;
        expect(call.path).toBe(`/api/v2/projects/${PROJECT_UUID}/alerting/history`);
        expect(call.headers.authorization).toBe(`ApiKey ${SERVICE_TOKEN}`);
    });

    it('passes rule_uuid, from, to and limit as ruleUuid, from, to, limit', async () => {
        const r = await h.call('alert_history', {
            rule_uuid: RULE,
            from: '2026-11-08T00:00:00Z',
            to: '2026-11-08T12:00:00Z',
            limit: 25,
        });
        expect(r.isError, r.text).toBe(false);
        const q = historyCalls().at(-1)!.query;
        expect(q.ruleUuid).toBe(RULE);
        expect(Date.parse(q.from!)).toBe(Date.parse('2026-11-08T00:00:00Z'));
        expect(Date.parse(q.to!)).toBe(Date.parse('2026-11-08T12:00:00Z'));
        expect(q.limit).toBe('25');
    });

    it('validates arguments before calling Lightdash', async () => {
        const before = historyCalls().length;
        expect((await h.call('alert_history', { limit: 0 })).isError).toBe(true);
        expect((await h.call('alert_history', { from: 'not-a-time' })).isError).toBe(true);
        expect(historyCalls().length).toBe(before);
    });
});
