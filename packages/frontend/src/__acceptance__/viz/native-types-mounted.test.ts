/**
 * Feature viz-native-types-mounted: the log stream and trace waterfall
 * views and config panels are mounted by the app (the explorer, dashboard
 * tiles and the config tabs), and both types are in the chart type gallery.
 * This reads the source because the full app can't be rendered without
 * renderWithProviders, whose mocks are broken (see PROGRESS.md).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');

const sourcesUnder = (dir: string): { file: string; text: string }[] =>
    readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
            return name === '__acceptance__' || name === 'node_modules'
                ? []
                : sourcesUnder(full);
        }
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
            ? [{ file: full, text: readFileSync(full, 'utf-8') }]
            : [];
    });

describe('the views and panels are mounted, not just written', () => {
    const sources = sourcesUnder(SRC);
    const usedOutside = (symbol: string, ownDir: string) =>
        sources.some(
            ({ file, text }) =>
                !file.startsWith(path.join(SRC, ownDir)) &&
                new RegExp(`\\b${symbol}\\b`).test(text),
        );

    it.each([
        ['LogStreamView', 'components/LogStream'],
        ['TraceWaterfallView', 'components/TraceWaterfall'],
        [
            'LogStreamConfigPanel',
            'components/VisualizationConfigs/LogStreamConfig',
        ],
        [
            'TraceWaterfallConfigPanel',
            'components/VisualizationConfigs/TraceWaterfallConfig',
        ],
    ])('%s is used by the app', (symbol, ownDir) => {
        expect(usedOutside(symbol, ownDir)).toBe(true);
    });

    it('offers both types in the chart type gallery', () => {
        const gallery = readFileSync(
            path.join(SRC, 'components/Explorer/ChartGallery/useChartTypeOptions.tsx'),
            'utf-8',
        );
        expect(gallery).toContain('ChartKind.LOG_STREAM');
        expect(gallery).toContain('ChartKind.TRACE_WATERFALL');
    });
});
