/**
 * Feature viz-docs: docs/eng-1799/viz.md documents the two native chart
 * types, the HouseRx chart registry and how to host it, and the mapping.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = path.resolve(__dirname, '../../../../../docs/eng-1799/viz.md');

describe('viz doc', () => {
    const text = readFileSync(DOC, 'utf-8');
    const headings = text
        .split('\n')
        .filter((line) => /^#{1,4} /.test(line))
        .join('\n')
        .toLowerCase();

    it('has a section for each native type and the registry', () => {
        expect(headings).toMatch(/log stream|log_stream/);
        expect(headings).toMatch(/trace waterfall|trace_waterfall/);
        expect(headings).toMatch(/registry/);
        expect(headings).toMatch(/host/);
        expect(headings).toMatch(/mapping/);
        expect(headings).toMatch(/contract assumptions/);
    });

    it('explains how to build and host the registry', () => {
        expect(text).toContain('LIGHTDASH_CHART_REGISTRY_URL');
        expect(text).toContain('chart-registry/dist');
        expect(text).toMatch(/pnpm -F chart-registry build/);
        expect(text).toMatch(/index\.json/);
    });

    it('names every registry entry', () => {
        for (const slug of [
            'heatmap',
            'state-timeline',
            'stat-sparkline',
            'bar-gauge',
            'histogram',
            'status-grid',
        ]) {
            expect(text).toContain(`\`${slug}\``);
        }
    });

    it('records the ee/ typecheck measurement', () => {
        expect(text).toMatch(/typecheck/i);
        expect(text).toMatch(/ee\//);
    });

    it('links the panel mapping table', () => {
        expect(text).toContain('grafana-panel-mapping.md');
    });

    it('uses the glossary: Tile, never Panel, for a dashboard item', () => {
        expect(text).not.toMatch(/\bdashboard panels?\b/i);
    });
});
