import { describe, expect, it, vi } from 'vitest';
import { AlertingError, type AlertingClient } from '../lightdash/alerting.js';
import { alertHistory, buildAlertHistoryQuery } from './alertHistory.js';

const RULE = 'a1a1a1a1-0000-4000-8000-000000000001';
const HISTORY = [{ ruleUuid: RULE, labels: { job: 'api' }, from: 'pending', to: 'firing', at: '2026-11-08T10:00:00Z' }];
const NOW = Date.parse('2026-11-08T12:00:00Z');

function fakeAlerting(get: AlertingClient['get']) {
    return { get: vi.fn(get) };
}

describe('buildAlertHistoryQuery', () => {
    it('sends nothing for no arguments', () => {
        expect(buildAlertHistoryQuery({}, NOW)).toEqual({
            ruleUuid: undefined,
            from: undefined,
            to: undefined,
            limit: undefined,
        });
    });

    it('maps rule_uuid, from, to and limit to ruleUuid, from, to and limit', () => {
        expect(
            buildAlertHistoryQuery(
                { rule_uuid: RULE, from: '2026-11-08T00:00:00+01:00', to: 'now-1h', limit: 25 },
                NOW,
            ),
        ).toEqual({
            ruleUuid: RULE,
            from: '2026-11-07T23:00:00.000Z',
            to: '2026-11-08T11:00:00.000Z',
            limit: '25',
        });
    });

    it.each([
        [{ rule_uuid: '../../admin' }, /rule_uuid/],
        [{ limit: 0 }, /limit/],
        [{ limit: 1001 }, /limit/],
        [{ limit: 2.5 }, /limit/],
        [{ from: 'not-a-time' }, /from/],
        [{ to: '2026-13-01' }, /to/],
        [{ from: 'now', to: 'now-1h' }, /to must not be before from/],
    ])('refuses %j', (args, message) => {
        expect(() => buildAlertHistoryQuery(args, NOW)).toThrow(message);
    });
});

describe('alert_history', () => {
    it('returns { results } untouched from the history endpoint', async () => {
        const alerting = fakeAlerting(async () => HISTORY);
        const r = await alertHistory(alerting, 200_000, { limit: 5 }, NOW);
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toEqual({ results: HISTORY });
        expect(alerting.get).toHaveBeenCalledWith('history', {
            ruleUuid: undefined,
            from: undefined,
            to: undefined,
            limit: '5',
        });
    });

    it('refuses bad arguments without calling Lightdash', async () => {
        const alerting = fakeAlerting(async () => HISTORY);
        expect((await alertHistory(alerting, 200_000, { limit: 0 }, NOW)).isError).toBe(true);
        expect((await alertHistory(alerting, 200_000, { from: 'yesterday' }, NOW)).isError).toBe(true);
        expect(alerting.get).not.toHaveBeenCalled();
    });

    it('turns a Lightdash failure into a tool error', async () => {
        const alerting = fakeAlerting(async () => {
            throw new AlertingError('The Lightdash alerting history request failed with HTTP 503: unavailable');
        });
        const r = await alertHistory(alerting, 200_000, {}, NOW);
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain('HTTP 503');
    });

    it('hides unexpected errors behind a fixed sentence', async () => {
        const alerting = fakeAlerting(async () => {
            throw new Error('secret detail');
        });
        const r = await alertHistory(alerting, 200_000, {}, NOW);
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).not.toContain('secret detail');
    });

    it('refuses a result over MCP_MAX_OUTPUT_BYTES', async () => {
        const alerting = fakeAlerting(async () => HISTORY);
        const size = Buffer.byteLength(JSON.stringify({ results: HISTORY }));
        expect((await alertHistory(alerting, size, {}, NOW)).isError).toBeUndefined();
        const r = await alertHistory(alerting, size - 1, {}, NOW);
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain('limit');
    });
});
