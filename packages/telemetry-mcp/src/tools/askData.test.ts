import { describe, expect, it } from 'vitest';
import type { AskResult } from '../ask/data-assistant.service.js';
import { ASK_DATA_TOO_LARGE, askDataResult, parseAskDataArgs } from './askData.js';
import { ToolInputError } from './telemetryArgs.js';

const result = (rows: Record<string, unknown>[], answer = 'There are 42 orders.'): AskResult => ({
    askId: 'ask-1',
    question: 'How many orders?',
    database: 'platform',
    model: 'claude-sonnet-5-5',
    answer: {
        status: 'answered',
        answer,
        confidence: 'high',
        assumptions: [],
        caveats: [],
        abstainReason: null,
        whatWouldHelp: [],
        evidenceQueries: [1],
        visualizations: [],
        followUps: [],
    },
    queries: [
        {
            index: 1,
            purpose: 'Count',
            sql: 'SELECT count(*) AS n FROM orders',
            status: 'ok',
            columns: ['n'],
            rows,
            moreRowsAvailable: false,
            durationMs: 3,
        },
    ],
    memory: { enabled: true, recalled: [], learned: [], flagged: 0 },
    rowsSharedWithModel: true,
    usage: { steps: 2, inputTokens: 200, outputTokens: 40 },
});

describe('parseAskDataArgs', () => {
    it('accepts a question of 1..1000 characters and optional history', () => {
        expect(parseAskDataArgs({ question: 'x' })).toEqual({ question: 'x', history: [] });
        expect(parseAskDataArgs({ question: 'x'.repeat(1000) }).question).toHaveLength(1000);
        const history = [{ question: 'q', answer: 'a' }];
        expect(parseAskDataArgs({ question: 'And now?', history }).history).toEqual(history);
    });

    it('refuses a missing, blank or over-long question and malformed history', () => {
        for (const args of [
            {},
            { question: '' },
            { question: '   ' },
            { question: 'x'.repeat(1001) },
            { question: 'q', history: 'earlier' },
            { question: 'q', history: [{ question: 'q' }] },
        ]) {
            expect(() => parseAskDataArgs(args)).toThrow(ToolInputError);
        }
    });
});

describe('askDataResult', () => {
    it('returns the AskResult as structured content and JSON text', () => {
        const r = askDataResult(result([{ n: 42 }]), 200_000);
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toMatchObject({ askId: 'ask-1', queries: [{ rows: [{ n: 42 }] }] });
        expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(r.structuredContent);
    });

    it('drops query rows when the result is over the byte cap, keeping the answer', () => {
        const rows = Array.from({ length: 200 }, (_, i) => ({ n: i, pad: 'p'.repeat(50) }));
        const r = askDataResult(result(rows), 5_000);
        expect(r.isError).toBeUndefined();
        const out = r.structuredContent as unknown as AskResult;
        expect(out.answer.answer).toContain('42');
        expect(out.queries[0]).toMatchObject({ rows: [], moreRowsAvailable: true, columns: ['n'] });
    });

    it('is an error when even the answer alone is over the cap', () => {
        const r = askDataResult(result([], 'a'.repeat(10_000)), 5_000);
        expect(r.isError).toBe(true);
        expect((r.content[0] as { text: string }).text).toBe(ASK_DATA_TOO_LARGE);
    });
});
