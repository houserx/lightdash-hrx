import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildPromqlQuery } from './queryPromql.js';
import { ToolInputError, durationMs, parseDuration, parseInstant, tableResult } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'prometheus-production', kind: 'prometheus', default: true, restricted: false },
    { name: 'loki-production', kind: 'loki', default: true, restricted: false },
];
const config = { sources };
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const NOW = Date.parse('2026-11-08T12:00:00Z');

describe('buildPromqlQuery', () => {
    it('builds promql($1..$4) with every value as a parameter', () => {
        const q = buildPromqlQuery(config, { query: 'up{job="a"}', start: START, end: END, step: '1m' }, NOW);
        expect(q.sql).toBe('SELECT * FROM promql($1, $2, $3, $4)');
        expect(q.params).toEqual(['up{job="a"}', '2026-11-08T10:00:00.000Z', '2026-11-08T11:00:00.000Z', '1m']);
    });

    it('appends a configured prometheus source as $5', () => {
        const q = buildPromqlQuery(
            config,
            { query: 'up', start: START, end: END, step: '30s', source: 'prometheus-production' },
            NOW,
        );
        expect(q.sql).toBe('SELECT * FROM promql($1, $2, $3, $4, $5)');
        expect(q.params.at(-1)).toBe('prometheus-production');
    });

    it('builds promql_instant($1, $2) for `at`', () => {
        const q = buildPromqlQuery(config, { query: 'up', at: '2026-11-08T11:00:00+01:00' }, NOW);
        expect(q.sql).toBe('SELECT * FROM promql_instant($1, $2)');
        expect(q.params).toEqual(['up', '2026-11-08T10:00:00.000Z']);
    });

    it('resolves now and now-<duration> against the given clock', () => {
        const q = buildPromqlQuery(config, { query: 'up', start: 'now-1h', end: 'now', step: '1m' }, NOW);
        expect(q.params.slice(1, 3)).toEqual(['2026-11-08T11:00:00.000Z', '2026-11-08T12:00:00.000Z']);
    });

    it.each([
        [{ query: 'up', start: START, end: END, step: 'abc' }],
        [{ query: 'up', start: START, end: END, step: '0s' }],
        [{ query: 'up', start: START, end: END }],
        [{ query: 'up', at: END, step: '1m' }],
        [{ query: ' ', at: END }],
        [{ query: 'up', start: END, end: START, step: '1m' }],
        [{ query: 'up', start: 'now', end: 'now-1h', step: '1m' }],
        [{ query: 'up', at: END, source: 'loki-production' }],
        [{ query: 'up', at: END, source: 'nope' }],
    ])('refuses %j', (args) => {
        expect(() => buildPromqlQuery(config, args, NOW)).toThrow(ToolInputError);
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
        expect(parseInstant('t', START, NOW)).toBe(Date.parse(START));
        expect(parseInstant('t', '2026-11-08T05:00:00-05:00', NOW)).toBe(Date.parse(START));
        expect(parseInstant('t', '2026-11-08', NOW)).toBe(Date.parse('2026-11-08T00:00:00Z'));
    });
    it.each([
        ['now', 0],
        [' NOW ', 0],
        ['now-1h', 3_600_000],
        ['now-30m', 1_800_000],
        ['now-2d', 2 * 86_400_000],
        ['now-1w', 7 * 86_400_000],
        ['now-1h30m', 5_400_000],
        ['now-500ms', 500],
    ])('resolves %j against the clock', (v, back) => {
        expect(parseInstant('t', v, NOW)).toBe(NOW - back);
    });
    it.each([
        '2026-13-45T99:00:00Z',
        '2026-02-30T00:00:00Z',
        '2026-11-08T10:00:00',
        'yesterday',
        'yesterday-ish',
        'March 7, 2026',
        'now-',
        'now-0m',
        'now-1.5h',
        'now-1m1h',
        'now+1h',
        'now - 1h',
        'now-1h-1h',
    ])('refuses %j', (v) => {
        expect(() => parseInstant('t', v, NOW)).toThrow(ToolInputError);
    });
});

describe('durationMs', () => {
    it('adds every unit, with a year as 365 days', () => {
        expect(durationMs('1y2w3d4h5m6s7ms')).toBe(
            365 * 86_400_000 + 14 * 86_400_000 + 3 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000 + 6_000 + 7,
        );
    });
});

describe('tableResult', () => {
    it('turns timestamps into ISO strings and counts rows', () => {
        const t = tableResult({
            columns: ['timestamp', 'value', 'labels', 'series'],
            rows: [{ timestamp: new Date(START), value: 1.5, labels: { job: 'api' }, series: '{job="api"}' }],
            truncated: false,
        });
        expect(t).toEqual({
            columns: ['timestamp', 'value', 'labels', 'series'],
            rows: [{ timestamp: '2026-11-08T10:00:00.000Z', value: 1.5, labels: { job: 'api' }, series: '{job="api"}' }],
            rowCount: 1,
            truncated: false,
        });
    });

    it('passes on the engine truncated flag; rowCount counts the rows returned', () => {
        const t = tableResult({
            columns: ['value'],
            rows: [{ value: 1 }, { value: 2 }],
            truncated: true,
        });
        expect(t).toEqual({ columns: ['value'], rows: [{ value: 1 }, { value: 2 }], rowCount: 2, truncated: true });
    });
});
