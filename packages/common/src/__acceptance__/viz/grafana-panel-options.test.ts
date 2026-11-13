/**
 * Feature viz-grafana-panel-option-mapping: every panel option the 32
 * dashboards use (the fixture lists each option path, never a value) maps to
 * where it lands in Lightdash, or is dropped with a reason.
 */
import { describe, expect, it } from 'vitest';
import { getGrafanaPanelOptionMapping } from '../../index';
import fixture from './fixtures/grafana-panel-options.json';

const TARGETS = [
    'builtin_chart_config',
    'native_chart_config',
    'registry_option',
    'field_format',
    'tile',
    'dropped',
];

describe('Grafana panel option mapping', () => {
    it('maps every option path the dashboards use', () => {
        const missing: string[] = [];
        for (const { panelType, path } of fixture.options) {
            const types =
                panelType === '*' ? fixture.panelTypes : [panelType];
            for (const type of types) {
                const mapping = getGrafanaPanelOptionMapping(type, path);
                if (!mapping || !TARGETS.includes(mapping.target)) {
                    missing.push(`${type} ${path}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('says where a kept option lands and why a dropped one is dropped', () => {
        for (const { panelType, path } of fixture.options) {
            const type = panelType === '*' ? 'timeseries' : panelType;
            const mapping = getGrafanaPanelOptionMapping(type, path)!;
            if (mapping.target === 'dropped') {
                expect(mapping.reason, `${type} ${path}`).toBeTruthy();
            } else {
                expect(mapping.lightdash, `${type} ${path}`).toBeTruthy();
            }
        }
    });

    it.each([
        ['logs', 'options.wrapLogMessage', 'native_chart_config', /wrapLines/],
        ['logs', 'options.sortOrder', 'native_chart_config', /newestFirst/],
        ['logs', 'options.showLabels', 'native_chart_config', /showLabels/],
        [
            'timeseries',
            'fieldConfig.defaults.custom.thresholdsStyle.mode',
            'builtin_chart_config',
            /thresholds/,
        ],
        [
            'timeseries',
            'fieldConfig.defaults.custom.stacking.mode',
            'builtin_chart_config',
            /stack/i,
        ],
        ['timeseries', 'fieldConfig.defaults.unit', 'field_format', /format/i],
        [
            'table',
            'fieldConfig.defaults.mappings',
            'builtin_chart_config',
            /valueMappings/,
        ],
        [
            'gauge',
            'fieldConfig.defaults.thresholds.steps',
            'builtin_chart_config',
            /sections/,
        ],
        ['stat', 'options.graphMode', 'registry_option', /graphMode/],
        ['stat', 'fieldConfig.defaults.mappings', 'registry_option', /valueMappings/],
        ['bargauge', 'options.displayMode', 'registry_option', /displayMode/],
        ['bargauge', 'options.orientation', 'registry_option', /orientation/],
        ['text', 'options.content', 'tile', /markdown/i],
    ])('maps %s %s to %s', (type, path, target, where) => {
        const mapping = getGrafanaPanelOptionMapping(type, path)!;
        expect(mapping).toBeDefined();
        expect(mapping.target).toBe(target);
        expect(mapping.lightdash).toMatch(where);
    });

    it('returns undefined for an option it does not know', () => {
        expect(
            getGrafanaPanelOptionMapping('timeseries', 'options.notAnOption'),
        ).toBeUndefined();
    });
});
