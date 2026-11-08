import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildTraceqlQuery } from './searchTraces.js';
import { ToolInputError } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'loki-production', kind: 'loki', default: true, restricted: false },
    { name: 'tempo-production', kind: 'tempo', default: true, restricted: false },
];
const config = { sources };
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const S = '2026-11-08T10:00:00.000Z';
const E = '2026-11-08T11:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const Q = '{ resource.service.name = "api" && duration > 1s }';

describe('buildTraceqlQuery', () => {
    it('builds traceql($1..$3) and leaves the limit to the engine default', () => {
        const q = buildTraceqlQuery(config, { query: Q, start: START, end: END }, NOW);
        expect(q.sql).toBe('SELECT * FROM traceql($1, $2, $3)');
        expect(q.params).toEqual([Q, S, E]);
    });

    it('sends the limit as a parameter', () => {
        const q = buildTraceqlQuery(config, { query: Q, start: START, end: END, limit: 10 }, NOW);
        expect(q.sql).toBe('SELECT * FROM traceql($1, $2, $3, $4)');
        expect(q.params).toEqual([Q, S, E, '10']);
        expect(q.sql).not.toContain('resource.service.name');
    });

    it('fills the limit with the contract default when only a source is given', () => {
        const q = buildTraceqlQuery(config, { query: Q, start: START, end: END, source: 'tempo-production' }, NOW);
        expect(q.sql).toBe('SELECT * FROM traceql($1, $2, $3, $4, $5)');
        expect(q.params).toEqual([Q, S, E, '20', 'tempo-production']);
        expect(
            buildTraceqlQuery(config, { query: Q, start: START, end: END, limit: 1000, source: 'tempo-production' }, NOW)
                .params,
        ).toEqual([Q, S, E, '1000', 'tempo-production']);
    });

    it('resolves relative times against the given clock', () => {
        const q = buildTraceqlQuery(config, { query: Q, start: 'now-1h', end: 'now' }, NOW);
        expect(q.params.slice(1, 3)).toEqual(['2026-11-08T11:00:00.000Z', '2026-11-08T12:00:00.000Z']);
    });

    it.each([
        ['an empty query', { query: ' ' }],
        ['a zero limit', { limit: 0 }],
        ['a negative limit', { limit: -5 }],
        ['a fractional limit', { limit: 2.5 }],
        ['a limit over 1000', { limit: 1001 }],
        ['a loki source', { source: 'loki-production' }],
        ['an unknown source', { source: 'nope' }],
        ['end before start', { start: END, end: START }],
    ])('refuses %s', (_label, extra) => {
        expect(() => buildTraceqlQuery(config, { query: Q, start: START, end: END, ...extra }, NOW)).toThrow(
            ToolInputError,
        );
    });
});
