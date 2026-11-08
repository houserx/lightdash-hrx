import { describe, expect, it } from 'vitest';
import { EngineError } from './client.js';
import { MAX_ENGINE_MESSAGE_LENGTH, engineErrorText, redactSecrets } from './errors.js';

const what = 'The PromQL query';

describe('engineErrorText', () => {
    it('42501 is access denied and keeps the missing claim', () => {
        const text = engineErrorText(
            new EngineError('permission denied: missing claim attrs.telemetry_restricted', '42501'),
            what,
        );
        expect(text).toMatch(/^Access denied: /);
        expect(text).toContain('attrs.telemetry_restricted');
        expect(text).toContain('SQLSTATE 42501');
        expect(text).toContain('ask a Lightdash admin');
    });

    it('42501 for a missing audit description does not blame a claim', () => {
        const text = engineErrorText(new EngineError('audited query requires a description', '42501'), what);
        expect(text).toMatch(/^Access denied: /);
        expect(text).toContain('must carry a description');
        expect(text).not.toContain('claim');
    });

    it('54000 is result too large with advice to narrow the query', () => {
        const text = engineErrorText(new EngineError('result exceeds max_rows', '54000'), what);
        expect(text).toMatch(/^Result too large: /);
        expect(text).toContain('result exceeds max_rows');
        expect(text).toMatch(/Narrow the query/);
        expect(text).toContain('shorter time range');
    });

    it('58000 is audit write failed, result withheld', () => {
        const text = engineErrorText(new EngineError('audit write failed', '58000'), what);
        expect(text).toMatch(/^Audit write failed: /);
        expect(text).toContain('no rows were returned');
    });

    it('other SQLSTATEs keep the engine message and code', () => {
        expect(engineErrorText(new EngineError('internal engine failure', 'XX000'), what)).toBe(
            'The PromQL query failed: internal engine failure (SQLSTATE XX000)',
        );
        expect(engineErrorText(new EngineError('could not reach the Federation Engine', undefined), what)).toBe(
            'The PromQL query failed: could not reach the Federation Engine',
        );
    });
});

describe('redactSecrets', () => {
    it('removes known secrets, longest first', () => {
        expect(redactSecrets('pw=hunter22 and hunter22-long', ['hunter22', 'hunter22-long', '', undefined])).toBe(
            'pw=[redacted] and [redacted]',
        );
    });

    it('removes identity tokens and JWTs even when not given', () => {
        const identity = 'eyJpc3MiOiJ0ZWxlbWV0cnktbWNwIn0.c2lnbmF0dXJlLWJ5dGVz';
        const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
        const text = redactSecrets(`bad token ${identity}; also ${jwt}.`, []);
        expect(text).toBe('bad token [redacted]; also [redacted].');
        expect(text).not.toContain('eyJ');
    });

    it('caps long messages', () => {
        expect(redactSecrets('x'.repeat(2000), []).length).toBe(MAX_ENGINE_MESSAGE_LENGTH + 1);
    });

    it('leaves ordinary engine messages alone', () => {
        const message = 'permission denied: missing claim attrs.telemetry_restricted';
        expect(redactSecrets(message, ['secret-value'])).toBe(message);
    });
});
