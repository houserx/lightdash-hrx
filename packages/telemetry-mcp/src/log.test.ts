import { describe, expect, it } from 'vitest';
import { MAX_LOG_STRING_LENGTH, createLogger, type LogFields } from './log.js';

const SECRET = 'test-identity-secret-not-real';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
    const lines: string[] = [];
    const logger = createLogger({ level, write: (l) => lines.push(l), secrets: [SECRET, undefined, ''], now: () => 0 });
    return { lines, logger, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('createLogger', () => {
    it('writes one JSON object per line with time, level and msg', () => {
        const { lines, logger, parsed } = capture();
        logger.info('tool call', { tool: 'query_promql', durationMs: 12, truncated: false, code: null });
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain('\n');
        expect(parsed()[0]).toEqual({
            time: '1970-01-01T00:00:00.000Z',
            level: 'info',
            msg: 'tool call',
            tool: 'query_promql',
            durationMs: 12,
            truncated: false,
            code: null,
        });
    });

    it('drops lines below the configured level', () => {
        const { logger, parsed } = capture('warn');
        logger.debug('a');
        logger.info('b');
        logger.warn('c');
        logger.error('d');
        expect(parsed().map((o) => o.level)).toEqual(['warn', 'error']);
    });

    it('redacts configured secrets and token-shaped strings in msg and fields', () => {
        const { lines, logger } = capture();
        logger.warn(`bad ${SECRET}`, { reason: `token ${JWT}` });
        expect(lines[0]).not.toContain(SECRET);
        expect(lines[0]).not.toContain(JWT);
        expect(lines[0]).toContain('[redacted]');
    });

    it('drops objects and arrays, reserved names and undefined values', () => {
        const { logger, parsed } = capture();
        const fields = {
            rows: [['ROW-VALUE']],
            result: { note: 'ROW-VALUE' },
            level: 'debug',
            msg: 'other',
            gone: undefined,
            n: Number.NaN,
        } as unknown as LogFields;
        logger.error('x', fields);
        expect(parsed()[0]).toEqual({ time: '1970-01-01T00:00:00.000Z', level: 'error', msg: 'x', n: null });
    });

    it('cuts long strings', () => {
        const { logger, parsed } = capture();
        logger.info('x', { reason: 'a'.repeat(1000) });
        expect((parsed()[0]!.reason as string).length).toBe(MAX_LOG_STRING_LENGTH + 1);
    });

    it('never throws when the writer does', () => {
        const logger = createLogger({
            level: 'info',
            write: () => {
                throw new Error('disk full');
            },
        });
        expect(() => logger.info('x')).not.toThrow();
    });
});
