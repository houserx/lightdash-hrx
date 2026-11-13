import { describe, expect, it } from 'vitest';
import { PLATFORM_QUERY_SQL, buildPlatformQuery } from './platformQuery.js';
import { ToolInputError } from './telemetryArgs.js';

const SQL = "SELECT status FROM orders WHERE note = 'x'; --";

describe('buildPlatformQuery', () => {
    it('sends the SQL only as the bind parameter of platform_query($1)', () => {
        const q = buildPlatformQuery({ sql: SQL, description: 'Why', ticket: 'ENG-123' });
        expect(q.sql).toBe(PLATFORM_QUERY_SQL);
        expect(q.sql).not.toContain('orders');
        expect(q.params).toEqual([SQL]);
    });

    it('puts the description unchanged and the ticket into the audit block', () => {
        expect(buildPlatformQuery({ sql: SQL, description: ' Backlog check ', ticket: 'OPS2-7' }).audit).toEqual({
            description: ' Backlog check ',
            ticket: 'OPS2-7',
        });
    });

    it('sends ticket null when none is given', () => {
        expect(buildPlatformQuery({ sql: SQL, description: 'Why' }).audit.ticket).toBeNull();
        expect(buildPlatformQuery({ sql: SQL, description: 'Why', ticket: null }).audit.ticket).toBeNull();
    });

    it.each([
        ['a missing sql', { description: 'Why' }],
        ['a blank sql', { sql: '  ', description: 'Why' }],
        ['a missing description', { sql: SQL }],
        ['a blank description', { sql: SQL, description: ' \n ' }],
        ['a non-string description', { sql: SQL, description: 5 }],
        ['a ticket with spaces', { sql: SQL, description: 'Why', ticket: 'not a ticket' }],
        ['a lower-case ticket', { sql: SQL, description: 'Why', ticket: 'eng-123' }],
        ['a ticket without a number', { sql: SQL, description: 'Why', ticket: 'ENG-' }],
        ['a ticket with issue number 0', { sql: SQL, description: 'Why', ticket: 'ENG-0' }],
        ['an empty ticket', { sql: SQL, description: 'Why', ticket: '' }],
        ['a ticket with a newline', { sql: SQL, description: 'Why', ticket: 'ENG-1\n' }],
    ])('refuses %s', (_label, args) => {
        expect(() => buildPlatformQuery(args)).toThrow(ToolInputError);
    });
});
