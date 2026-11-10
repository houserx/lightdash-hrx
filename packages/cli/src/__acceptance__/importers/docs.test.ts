/* eslint-disable */
// @ts-nocheck
// imp-docs: docs/eng-1799/importers.md explains usage of the three commands, the mapping, the
// warning catalogue (every code the fixture import produces) and how the routing fixes were
// chosen, in the glossary's terms.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './support';

const DOC = path.join(REPO_ROOT, 'docs/eng-1799/importers.md');
const SNAPSHOT = path.join(REPO_ROOT, 'docs/eng-1799/importers-warning-counts.json');
const read = () => readFileSync(DOC, 'utf8');

describe('docs/eng-1799/importers.md', () => {
    it('exists with the four sections', () => {
        expect(existsSync(DOC)).toBe(true);
        const doc = read();
        expect(doc).toMatch(/^## Usage/m);
        expect(doc).toMatch(/^## .*Mapping/im);
        expect(doc).toMatch(/^## Warning catalogue/m);
        expect(doc).toMatch(/^## Routing fixes/m);
    });

    it('documents each command and its options', () => {
        const doc = read();
        for (const text of [
            'lightdash import grafana-dashboard',
            'lightdash import grafana-alerts',
            'lightdash import perses-dashboard',
            '--out',
            '--space',
            '--dashboards-tf',
            '--datasources',
            '--ops-marts',
            '--no-tabs',
            '--rules',
            '--contact-points',
            '--policy',
            '--locals',
            '--folders',
            '--routing-decisions',
            '--no-routing-fixes',
            'IMPORT-REPORT.md',
            'ROUTING-FIXES.md',
            'import-summary.json',
        ]) {
            expect(doc, text).toContain(text);
        }
    });

    it('lists every warning code the fixtures produce', () => {
        const doc = read();
        const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
        const allCodes = new Set(Object.values(snapshot).flatMap((v) => Object.keys(v.byCode)));
        for (const code of [
            ...allCodes,
            'datasource-unsupported',
            'datasource-unresolved',
            'no-ops-mart',
            'expression-unsupported',
            'variable-multi-value',
            'transformation-unsupported',
            'panel-dropped',
            'option-dropped',
            'chart-kind-fallback',
            'annotations-unsupported',
            'refresh-adjusted',
            'rule-description-generated',
            'rule-needs-review',
            'routing-needs-decision',
            'perses-plugin-unsupported',
        ]) {
            expect(doc, code).toContain(`\`${code}\``);
        }
    });

    it('explains how the routing fixes were chosen', () => {
        const doc = read().toLowerCase();
        for (const text of ['unreachable route', 'unhandled severit', 'unreached contact point', 'default route only', 'notify', 'adr 0003', 'shadow run', 'deterministic']) {
            expect(doc, text).toContain(text);
        }
    });

    it('uses the glossary terms', () => {
        const doc = read();
        for (const avoided of [/\bdry run\b/i, /\bgo-live\b/i, /\bswitchover\b/i, /\bparallel run\b/i, /\bfederation proxy\b/i]) {
            expect(doc).not.toMatch(avoided);
        }
        expect(doc).toContain('Telemetry Source');
        expect(doc).toContain('Dashboard Time Range');
        expect(doc).toContain('Alert Rule');
        expect(doc).toContain('Contact Point');
        expect(doc).toContain('Notification Route');
    });
});
