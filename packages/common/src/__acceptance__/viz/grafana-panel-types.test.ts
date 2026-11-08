/**
 * Feature viz-grafana-panel-type-mapping: every Grafana panel type in the
 * 32 dashboards of the infra snapshot maps to a Lightdash equivalent, in a
 * typed module the importer line consumes.
 */
import { describe, expect, it } from 'vitest';
import {
    ChartType,
    GRAFANA_PANEL_MAPPINGS,
    getGrafanaPanelMapping,
} from '../../index';
import fixture from './fixtures/grafana-panel-options.json';

const TARGETS = [
    'builtin_chart',
    'native_chart',
    'registry_chart',
    'markdown_tile',
    'heading_tile',
    'dropped',
];

const REGISTRY_SLUGS = [
    'heatmap',
    'state-timeline',
    'stat-sparkline',
    'bar-gauge',
    'histogram',
    'status-grid',
];

describe('Grafana panel type mapping', () => {
    it('covers every panel type the dashboards use', () => {
        expect(fixture.panelTypes).toHaveLength(15);
        for (const type of fixture.panelTypes) {
            const mapping = getGrafanaPanelMapping(type);
            expect(mapping, type).toBeDefined();
            expect(TARGETS, type).toContain(mapping!.target);
        }
    });

    it('exposes the same data as a record', () => {
        for (const type of fixture.panelTypes) {
            expect(GRAFANA_PANEL_MAPPINGS[type]).toEqual(
                getGrafanaPanelMapping(type),
            );
        }
    });

    it('returns undefined for a panel type it does not know', () => {
        expect(getGrafanaPanelMapping('not-a-panel')).toBeUndefined();
    });

    it.each([
        ['timeseries', 'builtin_chart', ChartType.CARTESIAN],
        ['graph', 'builtin_chart', ChartType.CARTESIAN],
        ['barchart', 'builtin_chart', ChartType.CARTESIAN],
        ['gauge', 'builtin_chart', ChartType.GAUGE],
        ['table', 'builtin_chart', ChartType.TABLE],
        ['table-old', 'builtin_chart', ChartType.TABLE],
        ['piechart', 'builtin_chart', ChartType.PIE],
        ['logs', 'native_chart', ChartType.LOG_STREAM],
    ])('maps %s to a %s of type %s', (type, target, chartType) => {
        const mapping = getGrafanaPanelMapping(type)!;
        expect(mapping.target).toBe(target);
        expect(mapping.chartType).toBe(chartType);
    });

    it.each([
        ['stat', 'stat-sparkline'],
        ['bargauge', 'bar-gauge'],
    ])('maps %s to the %s registry entry', (type, slug) => {
        const mapping = getGrafanaPanelMapping(type)!;
        expect(mapping.target).toBe('registry_chart');
        expect(mapping.registrySlug).toBe(slug);
        expect(REGISTRY_SLUGS).toContain(mapping.registrySlug);
    });

    it('maps text to a markdown tile and row to a heading tile', () => {
        expect(getGrafanaPanelMapping('text')!.target).toBe('markdown_tile');
        expect(getGrafanaPanelMapping('row')!.target).toBe('heading_tile');
    });

    it('gives a reason for every dropped panel type', () => {
        const dropped = fixture.panelTypes
            .map((type) => getGrafanaPanelMapping(type)!)
            .filter((mapping) => mapping.target === 'dropped');
        for (const mapping of dropped) {
            expect(mapping.reason, mapping.grafanaType).toBeTruthy();
            expect(mapping.reason!.length).toBeGreaterThan(10);
        }
    });

    it('names its own Grafana type', () => {
        for (const type of fixture.panelTypes) {
            expect(getGrafanaPanelMapping(type)!.grafanaType).toBe(type);
        }
    });
});
