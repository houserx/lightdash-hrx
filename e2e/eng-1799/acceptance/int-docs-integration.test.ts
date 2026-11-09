/* eslint-disable */
// @ts-nocheck
// int-docs-integration: docs/eng-1799/integration.md explains how to run the e2e suite, what each
// check proves (every acceptance file is listed by its feature id), and links the reconciled
// assumptions; e2e/eng-1799/run-all.sh runs every check one file at a time through the runner.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from './support';

describe('int-docs-integration', () => {
    it('documents the suite and every check', () => {
        const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/eng-1799/integration.md'), 'utf8');
        for (const heading of [/^## Running the e2e suite/m, /^## What each check proves/m, /^## Reconciled assumptions/m, /^## Harness/m]) expect(doc).toMatch(heading);
        expect(doc).toContain('bash ./init.sh');
        expect(doc).toContain('e2e/eng-1799/acceptance/run.sh');
        expect(doc).toContain('e2e/eng-1799/run-all.sh');
        expect(doc).toContain('contract-assumptions.md');
        expect(doc).toMatch(/No Docker/i);
        const ids = fs
            .readdirSync(path.join(REPO_ROOT, 'e2e/eng-1799/acceptance'))
            .filter((f) => f.endsWith('.test.ts'))
            .map((f) => f.replace(/\.test\.ts$/, ''));
        expect(ids.length).toBeGreaterThanOrEqual(30);
        const proves = doc.slice(doc.search(/^## What each check proves/m));
        for (const id of ids) expect(proves, id).toContain(id);
        // Glossary: never the avoided terms.
        expect(doc).not.toMatch(/\bdatasource\b(?!Error)/i);
        expect(doc).not.toMatch(/\bdry run\b/i);
    });

    it('ships a whole-suite runner that goes through the protected runner one file at a time', () => {
        const file = path.join(REPO_ROOT, 'e2e/eng-1799/run-all.sh');
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.statSync(file).mode & 0o111).not.toBe(0);
        const text = fs.readFileSync(file, 'utf8');
        expect(text).toContain('acceptance/run.sh');
        expect(text).not.toMatch(/docker/i);
    });
});
