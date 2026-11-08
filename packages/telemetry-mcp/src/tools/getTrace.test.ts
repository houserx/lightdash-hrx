import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildTraceQuery } from './getTrace.js';
import { ToolInputError } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'loki-production', kind: 'loki', default: true, restricted: false },
    { name: 'tempo-production', kind: 'tempo', default: true, restricted: false },
];
const config = { sources };
const ID = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('buildTraceQuery', () => {
    it('builds trace($1) with the id as a parameter', () => {
        const q = buildTraceQuery(config, { trace_id: ID });
        expect(q.sql).toBe('SELECT * FROM trace($1)');
        expect(q.params).toEqual([ID]);
    });

    it('accepts a 16-hex id and upper case', () => {
        expect(buildTraceQuery(config, { trace_id: '00F067AA0BA902B7' }).params).toEqual(['00F067AA0BA902B7']);
    });

    it('sends a tempo source as $2', () => {
        const q = buildTraceQuery(config, { trace_id: ID, source: 'tempo-production' });
        expect(q.sql).toBe('SELECT * FROM trace($1, $2)');
        expect(q.params).toEqual([ID, 'tempo-production']);
    });

    it.each([
        ['a non-hex id', { trace_id: 'xyz' }],
        ['an injection attempt', { trace_id: "4bf92f35'); --" }],
        ['a 40-hex id', { trace_id: `${ID}4bf92f35` }],
        ['a 15-hex id', { trace_id: '00f067aa0ba902b' }],
        ['an empty id', { trace_id: '' }],
        ['an id with a newline', { trace_id: `${ID}\n` }],
        ['a loki source', { trace_id: ID, source: 'loki-production' }],
        ['an unknown source', { trace_id: ID, source: 'nope' }],
    ])('refuses %s', (_label, args) => {
        expect(() => buildTraceQuery(config, args)).toThrow(ToolInputError);
    });
});
