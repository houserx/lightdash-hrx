import { describe, expect, it } from 'vitest';
import { exists, findUnitTest } from './helpers/files';
import { portedTestsPass } from './helpers/port';

// Portal api/src/services/data-assistant.service.test.ts has 33 cases. A few assert portal-only
// plumbing (its own audit writer, Express HttpError codes); those are adapted to the engine-side audit
// (CONTRACTS §6), so at least 28 must survive the port. ask-domain-notes.ts is ported verbatim.
describe('data-assistant port', () => {
    portedTestsPass('data-assistant.service.test.ts', 28);

    it('ports ask-domain-notes.ts next to the data assistant', () => {
        const dir = findUnitTest('data-assistant.service.test.ts').replace(/\/[^/]+$/, '');
        const rel = dir.slice(dir.indexOf('/src/') + 1);
        expect(exists(`${rel}/ask-domain-notes.ts`)).toBe(true);
    });
});
