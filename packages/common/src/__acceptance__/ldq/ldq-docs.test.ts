// ldq-docs: docs/eng-1799/ldq.md explains what was built, how to configure an Operations
// Project on the federation warehouse, and which user attributes to create.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const docPath = path.resolve(__dirname, '../../../../../docs/eng-1799/ldq.md');

describe('docs/eng-1799/ldq.md', () => {
    it('exists', () => {
        expect(existsSync(docPath)).toBe(true);
    });

    it('covers configuration, attributes and every built area', () => {
        const doc = readFileSync(docPath, 'utf8');
        for (const term of [
            'Operations Project',
            'Federation Engine',
            "flavor: 'federation'",
            'identitySigningSecret',
            'httpBaseUrl',
            '5433',
            'telemetry_restricted',
            'platform_read',
            'platform_write',
            'platform_explain',
            'Dashboard Time Range',
            '__interval',
            'Investigate',
            'Write Mode',
            'Preview',
            'Audited Query',
            'lightdash import portal-scripts',
        ]) {
            expect(doc).toContain(term);
        }
        for (const avoided of ['Elevated mode', 'Dry run', 'Time picker']) {
            expect(doc).not.toContain(avoided);
        }
    });
});
