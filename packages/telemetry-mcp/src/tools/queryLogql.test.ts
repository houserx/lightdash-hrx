import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildLogqlQuery } from './queryLogql.js';
import { ToolInputError } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'prometheus-production', kind: 'prometheus', default: true, restricted: false },
    { name: 'loki-production', kind: 'loki', default: true, restricted: false },
];
const config = { sources };
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const S = '2026-11-08T10:00:00.000Z';
const E = '2026-11-08T11:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const Q = '{app="api"} |= "timeout"';

describe('buildLogqlQuery', () => {
    it('builds logql($1..$3) and leaves limit and direction to the engine defaults', () => {
        const q = buildLogqlQuery(config, { query: Q, start: START, end: END }, NOW);
        expect(q.sql).toBe('SELECT * FROM logql($1, $2, $3)');
        expect(q.params).toEqual([Q, S, E]);
    });

    it('sends limit and direction as parameters', () => {
        const q = buildLogqlQuery(config, { query: Q, start: START, end: END, limit: 50, direction: 'forward' }, NOW);
        expect(q.sql).toBe('SELECT * FROM logql($1, $2, $3, $4, $5)');
        expect(q.params).toEqual([Q, S, E, '50', 'forward']);
    });

    it('fills the positional gaps with the contract defaults', () => {
        expect(buildLogqlQuery(config, { query: Q, start: START, end: END, direction: 'forward' }, NOW).params).toEqual([
            Q, S, E, '1000', 'forward',
        ]);
        expect(buildLogqlQuery(config, { query: Q, start: START, end: END, limit: 5 }, NOW).params).toEqual([
            Q, S, E, '5',
        ]);
        expect(
            buildLogqlQuery(config, { query: Q, start: START, end: END, source: 'loki-production' }, NOW).params,
        ).toEqual([Q, S, E, '1000', 'backward', 'loki-production']);
    });

    it('builds logql_metric($1..$4) when a step is given', () => {
        const q = buildLogqlQuery(config, { query: 'count_over_time({app="a"}[5m])', start: START, end: END, step: '5m' }, NOW);
        expect(q.sql).toBe('SELECT * FROM logql_metric($1, $2, $3, $4)');
        expect(q.params).toEqual(['count_over_time({app="a"}[5m])', S, E, '5m']);
        const withSource = buildLogqlQuery(
            config,
            { query: 'x', start: START, end: END, step: '1m', source: 'loki-production' },
            NOW,
        );
        expect(withSource.sql).toBe('SELECT * FROM logql_metric($1, $2, $3, $4, $5)');
    });

    it('resolves relative times against the given clock', () => {
        const q = buildLogqlQuery(config, { query: Q, start: 'now-1h', end: 'now' }, NOW);
        expect(q.params.slice(1, 3)).toEqual(['2026-11-08T11:00:00.000Z', '2026-11-08T12:00:00.000Z']);
    });

    it.each([
        ['an empty query', { query: ' ' }],
        ['a bad direction', { direction: 'sideways' }],
        ['a negative limit', { limit: -1 }],
        ['a zero limit', { limit: 0 }],
        ['a fractional limit', { limit: 1.5 }],
        ['a limit beyond int', { limit: 2 ** 31 }],
        ['a bad step', { step: 'soon' }],
        ['limit with step', { step: '1m', limit: 10 }],
        ['direction with step', { step: '1m', direction: 'forward' }],
        ['a prometheus source', { source: 'prometheus-production' }],
        ['an unknown source', { source: 'nope' }],
        ['end before start', { start: END, end: START }],
    ])('refuses %s', (_label, extra) => {
        expect(() => buildLogqlQuery(config, { query: Q, start: START, end: END, ...extra }, NOW)).toThrow(
            ToolInputError,
        );
    });
});
