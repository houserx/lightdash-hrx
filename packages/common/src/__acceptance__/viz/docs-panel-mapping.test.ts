/**
 * Feature viz-docs-panel-mapping: docs/eng-1799/grafana-panel-mapping.md
 * maps every Grafana panel type and every panel option the dashboards use.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/grafana-panel-options.json';

const DOC = path.resolve(
    __dirname,
    '../../../../../docs/eng-1799/grafana-panel-mapping.md',
);

describe('Grafana panel mapping doc', () => {
    const text = readFileSync(DOC, 'utf-8');

    it('has a table row for every panel type', () => {
        for (const type of fixture.panelTypes) {
            expect(text, type).toMatch(
                new RegExp(`^\\|\\s*\`${type.replace(/[-]/g, '\\-')}\`\\s*\\|`, 'm'),
            );
        }
    });

    it('lists every option path the dashboards use', () => {
        const missing = fixture.options
            .map((o) => o.path)
            .filter((p) => !text.includes(`\`${p}\``));
        expect(missing).toEqual([]);
    });

    it('names each kind of Lightdash target', () => {
        for (const word of [
            'built-in',
            'native',
            'registry',
            'markdown',
            'heading',
            'dropped',
        ]) {
            expect(text.toLowerCase()).toContain(word);
        }
    });

    it('points at the typed module', () => {
        expect(text).toContain(
            'packages/common/src/eng1799/grafanaPanelMapping.ts',
        );
    });
});
