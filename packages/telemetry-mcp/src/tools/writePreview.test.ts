import { describe, expect, it } from 'vitest';
import { ToolInputError } from './telemetryArgs.js';
import {
    PLATFORM_WRITE_REQUIRED,
    PLATFORM_WRITE_UNCHECKED,
    buildPreviewRequest,
    previewResult,
    writeAccessDenial,
} from './writePreview.js';

const STATEMENT = "DELETE FROM orders WHERE id = 1 RETURNING id; --'";

describe('buildPreviewRequest', () => {
    it('passes the statement and description unchanged, with the ticket or null', () => {
        expect(buildPreviewRequest({ statement: STATEMENT, description: ' Why ', ticket: 'ENG-9' })).toEqual({
            statement: STATEMENT,
            description: ' Why ',
            ticket: 'ENG-9',
        });
        expect(buildPreviewRequest({ statement: STATEMENT, description: 'Why' }).ticket).toBeNull();
        expect(buildPreviewRequest({ statement: STATEMENT, description: 'Why', ticket: null }).ticket).toBeNull();
    });

    it.each([
        ['a missing statement', { description: 'Why' }],
        ['a blank statement', { statement: ' ', description: 'Why' }],
        ['a missing description', { statement: STATEMENT }],
        ['a blank description', { statement: STATEMENT, description: ' \n' }],
        ['a non-string description', { statement: STATEMENT, description: 1 }],
        ['a malformed ticket', { statement: STATEMENT, description: 'Why', ticket: 'eng-1' }],
    ])('refuses %s', (_label, args) => {
        expect(() => buildPreviewRequest(args)).toThrow(ToolInputError);
    });
});

describe('previewResult', () => {
    const result = { audit_id: 'a-1', rows_affected: 2, preview: true as const, returning: [{ id: 1 }, { id: 2 }] };

    it('returns the engine reply as structured content and JSON text', () => {
        const r = previewResult(result, 10_000);
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toEqual(result);
        expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(result);
    });

    it('is an error naming the audit id when the reply is over MCP_MAX_OUTPUT_BYTES', () => {
        const r = previewResult(result, 20);
        expect(r.isError).toBe(true);
        expect((r.content[0] as { text: string }).text).toMatch(/audit id a-1.*nothing committed/);
    });
});

describe('writeAccessDenial', () => {
    it('allows a caller with platform_write', async () => {
        await expect(writeAccessDenial(() => Promise.resolve({ platform_write: true }))).resolves.toBeUndefined();
    });

    it('refuses a caller without platform_write, naming the attribute', async () => {
        const denial = await writeAccessDenial(() => Promise.resolve({ platform_write: false }));
        expect(denial).toBe(PLATFORM_WRITE_REQUIRED);
        expect(denial).toMatch(/platform_write/);
    });

    it('fails closed when the attributes cannot be read', async () => {
        await expect(writeAccessDenial(() => Promise.reject(new Error('lightdash down')))).resolves.toBe(
            PLATFORM_WRITE_UNCHECKED,
        );
    });
});
