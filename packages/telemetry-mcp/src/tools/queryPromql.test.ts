import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildPromqlQuery } from './queryPromql.js';
import { ToolInputError, parseDuration, parseInstant, tableResult } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'prometheus-production', kind: 'prometheus', default: true, restricted: false },
    { name: 'loki-production', kind: 'loki', default: true, restricted: false },
];
const config = { sources };
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';

describe('buildPromqlQuery', () => {
    it('builds promql($1..$4) with every value as a parameter', () => {
        const q = buildPromqlQuery(config, { query: 'up{job="a"}', start: START, end: END, step: '1m' });
        expect(q.sql).toBe('SELECT * FROM promql($1, $2, $3, $4)');
        expect(q.params).toEqual(['up{job="a"}', '2026-11-08T10:00:00.000Z', '2026-11-08T11:00:00.000Z', '1m']);
    });

    it('appends a configured prometheus source as $5', () => {
        const q = buildPromqlQuery(config, {
            query: 'up',
            start: START,
            end: END,
            step: '30s',
            source: 'prometheus-production',
        });
        expect(q.sql).toBe('SELECT * FROM promql($1, $2, $3, $4, $5)');
        expect(q.params.at(-1)).toBe('prometheus-production');
    });

    it('builds promql_instant($1, $2) for `at`', () => {
        const q = buildPromqlQuery(config, { query: 'up', at: '2026-11-08T11:00:00+01:00' });
        expect(q.sql).toBe('SELECT * FROM promql_instant($1, $2)');
        expect(q.params).toEqual(['up', '2026-11-08T10:00:00.000Z']);
    });

    it.each([
        [{ query: 'up', start: START, end: END, step: 'abc' }],
        [{ query: 'up', start: START, end: END, step: '0s' }],
        [{ query: 'up', start: START, end: END }],
        [{ query: 'up', at: END, step: '1m' }],
        [{ query: ' ', at: END }],
        [{ query: 'up', start: END, end: START, step: '1m' }],
        [{ query: 'up', at: END, source: 'loki-production' }],
        [{ query: 'up', at: END, source: 'nope' }],
    ])('refuses %j', (args) => {
        expect(() => buildPromqlQuery(config, args)).toThrow(ToolInputError);
    });
});

describe('parseDuration', () => {
    it.each(['30s', '1m', '1h30m', '250ms', '1d', '2w'])('accepts %s', (v) => {
        expect(parseDuration('step', v)).toBe(v);
    });
    it.each(['', 'abc', '5 minutes', '1m; DROP', 'm', '0m', '1m1h', '1.5m', '-1m'])('refuses %j', (v) => {
        expect(() => parseDuration('step', v)).toThrow(ToolInputError);
    });
});

describe('parseInstant', () => {
    it('accepts Z, offsets and dates', () => {
        expect(parseInstant('t', START)).toBe(Date.parse(START));
        expect(parseInstant('t', '2026-11-08T05:00:00-05:00')).toBe(Date.parse(START));
        expect(parseInstant('t', '2026-11-08')).toBe(Date.parse('2026-11-08T00:00:00Z'));
    });
    it.each(['2026-13-45T99:00:00Z', '2026-02-30T00:00:00Z', '2026-11-08T10:00:00', 'yesterday', 'March 7, 2026'])(
        'refuses %j',
        (v) => {
            expect(() => parseInstant('t', v)).toThrow(ToolInputError);
        },
    );
});

describe('tableResult', () => {
    it('turns timestamps into ISO strings and counts rows', () => {
        const t = tableResult({
            columns: ['timestamp', 'value', 'labels', 'series'],
            rows: [{ timestamp: new Date(START), value: 1.5, labels: { job: 'api' }, series: '{job="api"}' }],
        });
        expect(t).toEqual({
            columns: ['timestamp', 'value', 'labels', 'series'],
            rows: [{ timestamp: '2026-11-08T10:00:00.000Z', value: 1.5, labels: { job: 'api' }, series: '{job="api"}' }],
            rowCount: 1,
            truncated: false,
        });
    });
});
