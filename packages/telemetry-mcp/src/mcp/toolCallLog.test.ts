import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { describeResponse, logToolCalls, pendingToolCalls } from './toolCallLog.js';

function fakeTransport() {
    const sent: JSONRPCMessage[] = [];
    const transport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (m: JSONRPCMessage) => {
            sent.push(m);
        },
    } as Transport;
    return { transport, sent };
}

function call(id: number | string, name: unknown, args: Record<string, unknown> = {}) {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

describe('pendingToolCalls', () => {
    it('finds tools/call requests in a single message or a batch', () => {
        const now = () => 5;
        expect([...pendingToolCalls(call(1, 'query_promql'), now)]).toEqual([[1, { tool: 'query_promql', start: 5 }]]);
        const batch = [call('a', 'platform_query'), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { method: 'x' }];
        expect([...pendingToolCalls(batch, now).keys()]).toEqual(['a']);
        expect(pendingToolCalls('not json', now).size).toBe(0);
    });

    it('logs a name that is not a plain identifier as (invalid)', () => {
        const calls = pendingToolCalls([call(1, 'x y; DROP'), call(2, 42), call(3, 'a'.repeat(65))], () => 0);
        expect([...calls.values()].map((c) => c.tool)).toEqual(['(invalid)', '(invalid)', '(invalid)']);
    });
});

describe('describeResponse', () => {
    it('reads outcome and counts, never content', () => {
        const ok = describeResponse({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'ROW' }], structuredContent: { rowCount: 3, truncated: true } },
        });
        expect(ok).toEqual({ outcome: 'ok', rowCount: 3, truncated: true });
        expect(describeResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } })).toMatchObject({
            outcome: 'error',
        });
        expect(describeResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad SQL' } })).toEqual({
            outcome: 'rejected',
            code: -32602,
        });
    });
});

describe('logToolCalls', () => {
    it('writes one line per tool call response, without arguments or result text', async () => {
        const lines: string[] = [];
        const logger = createLogger({ level: 'debug', write: (l) => lines.push(l) });
        const { transport, sent } = fakeTransport();
        let t = 100;
        logToolCalls(transport, [call(1, 'platform_query', { sql: 'SELECT SQL-TEXT' }), call(2, 'query_promql')], logger, 'u1', () => t);
        t = 130;
        await transport.send({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ROW-TEXT' }] } });
        await transport.send({ jsonrpc: '2.0', method: 'notifications/message' } as JSONRPCMessage);
        await transport.send({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [] } });
        await transport.send({ jsonrpc: '2.0', id: 2, result: { content: [] } });
        expect(sent).toHaveLength(4);
        const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({ level: 'info', msg: 'tool call', tool: 'platform_query', user: 'u1', outcome: 'ok', durationMs: 30 });
        expect(parsed[1]).toMatchObject({ level: 'warn', tool: 'query_promql', outcome: 'error' });
        expect(lines.join('\n')).not.toMatch(/SQL-TEXT|ROW-TEXT/);
    });

    it('leaves the transport alone when the body has no tool call', () => {
        const { transport } = fakeTransport();
        const send = transport.send;
        logToolCalls(transport, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, createLogger({ level: 'info' }), undefined);
        expect(transport.send).toBe(send);
    });
});
