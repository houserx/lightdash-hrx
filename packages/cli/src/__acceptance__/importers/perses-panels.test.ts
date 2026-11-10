/* eslint-disable */
// @ts-nocheck
// imp-perses-panels: Perses panel plugins map through the same panel mapping as Grafana:
// TimeSeriesChart -> line, BarChart -> vertical_bar, StatChart and GaugeChart -> big_number
// (with a chart-kind-fallback warning), Table -> table, Markdown -> markdown tile; an unknown
// plugin is a perses-plugin-unsupported warning and a TODO tile.
import path from 'node:path';
import { PERSES, chartTiles, generateSlug, importPerses } from './support';

let run: any;
beforeAll(async () => {
    run = await importPerses([path.join(PERSES, 'node-overview.yaml')]);
});
afterAll(() => run?.cleanup());

const dashboard = () => run.dashboards()[0].doc;
const chart = (title) => chartTiles(run, dashboard()).find((t) => t.tile.properties.title === title)?.chart;

describe('Perses panels', () => {
    it('maps chart plugins to SQL chart kinds', () => {
        expect(chart('CPU usage').chartKind).toBe('line');
        expect(chart('Errors by instance').chartKind).toBe('vertical_bar');
        expect(chart('Targets up').chartKind).toBe('big_number');
        expect(chart('Memory used').chartKind).toBe('big_number');
        expect(chart('Scrape durations').chartKind).toBe('table');
        expect(chart('CPU usage').description).toContain('Share of CPU time spent outside idle.');
    });

    it('maps Markdown to a markdown tile', () => {
        const md = dashboard().tiles.find((t) => t.type === 'markdown' && t.properties.title === 'About');
        expect(md.properties.content).toContain('## Node overview');
    });

    it('maps chart options as far as the kind supports', () => {
        const cpu = chart('CPU usage');
        expect(cpu.config.display.legend.position).toBe('right');
        const stack = cpu.config.display?.stack ?? cpu.config.fieldConfig?.stack;
        expect([true, 'stack']).toContain(stack);
        expect(JSON.stringify(chart('Targets up').config.display.conditionalFormatting)).toContain('1');
    });

    it('warns about fallbacks and unknown plugins', () => {
        const summary = run.summary();
        expect(summary.warnings.byCode['chart-kind-fallback']).toBeGreaterThanOrEqual(1);
        expect(summary.warnings.byCode['perses-plugin-unsupported']).toBe(1);
        const todo = dashboard().tiles.find((t) => t.type === 'markdown' && t.properties.title.includes('Latency heatmap'));
        expect(todo.properties.content).toMatch(/TODO/);
        expect(run.report(generateSlug('Node overview'))).toContain('HeatmapChart');
    });
});
