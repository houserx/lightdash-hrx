import { describe, expect, it, vi } from 'vitest';
import { AlertingError, type AlertingClient } from '../lightdash/alerting.js';
import { alertState } from './alertState.js';

const RULE = 'a1a1a1a1-0000-4000-8000-000000000001';
const STATE = [{ ruleUuid: RULE, name: 'API 5xx rate high', state: 'firing', series: [] }];

function fakeAlerting(get: AlertingClient['get']) {
    return { get: vi.fn(get) };
}

describe('alert_state', () => {
    it('returns { results } untouched, as structured content and JSON text', async () => {
        const alerting = fakeAlerting(async () => STATE);
        const r = await alertState(alerting, 200_000, {});
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toEqual({ results: STATE });
        expect(r.content).toEqual([{ type: 'text', text: JSON.stringify({ results: STATE }) }]);
        expect(alerting.get).toHaveBeenCalledWith('state', { rule: undefined, ruleUuid: undefined });
    });

    it('sends rule_uuid as Lightdash rule (and ruleUuid)', async () => {
        const alerting = fakeAlerting(async () => STATE);
        await alertState(alerting, 200_000, { rule_uuid: RULE });
        expect(alerting.get).toHaveBeenCalledWith('state', { rule: RULE, ruleUuid: RULE });
    });

    it.each(['../../admin', '', 'a1a1a1a1-0000-4000-8000-00000000000g', `${RULE}?x=1`])(
        'refuses rule_uuid %j without calling Lightdash',
        async (rule_uuid) => {
            const alerting = fakeAlerting(async () => STATE);
            const r = await alertState(alerting, 200_000, { rule_uuid });
            expect(r.isError).toBe(true);
            expect(alerting.get).not.toHaveBeenCalled();
        },
    );

    it('turns a Lightdash failure into a tool error', async () => {
        const alerting = fakeAlerting(async () => {
            throw new AlertingError('The Lightdash alerting state request failed with HTTP 503: unavailable');
        });
        const r = await alertState(alerting, 200_000, {});
        expect(r.isError).toBe(true);
        expect(r.content).toEqual([{ type: 'text', text: expect.stringContaining('HTTP 503') }]);
    });

    it('hides unexpected errors behind a fixed sentence', async () => {
        const alerting = fakeAlerting(async () => {
            throw new Error('secret detail');
        });
        const r = await alertState(alerting, 200_000, {});
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).not.toContain('secret detail');
    });

    it('refuses a result over MCP_MAX_OUTPUT_BYTES and suggests rule_uuid', async () => {
        const alerting = fakeAlerting(async () => STATE);
        const size = Buffer.byteLength(JSON.stringify({ results: STATE }));
        expect((await alertState(alerting, size, {})).isError).toBeUndefined();
        const r = await alertState(alerting, size - 1, {});
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain('rule_uuid');
        expect(r.structuredContent).toBeUndefined();
    });
});
