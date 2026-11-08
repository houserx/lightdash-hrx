/**
 * Feature viz-log-stream-model: `renderChart` from @lightdash/visualization
 * turns logs-shaped query results into a log stream model: one line per row
 * with its timestamp, text, normalised level, level colour and labels.
 */
import { describe, expect, it } from 'vitest';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderLogStream } from './fixtures';

describe('log stream model', () => {
    it('renders as a logStream, not an ECharts option', () => {
        expect(renderLogStream(FIVE_LOGS, LOG_FIELD_IDS).kind).toBe(
            'logStream',
        );
    });

    it('has one line per row, with text, timestamp and labels', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            newestFirst: false,
        });
        expect(model.lines).toHaveLength(5);
        expect(model.lines[1].line).toBe('upstream request timeout after 30s');
        expect(new Date(model.lines[1].timestamp).toISOString()).toBe(
            '2026-11-08T10:00:02.000Z',
        );
        expect(model.lines[1].labels).toEqual({
            app: 'api',
            namespace: 'synthetic',
            pod: 'api-2',
        });
        expect(new Set(model.lines.map((l: { id: string }) => l.id)).size).toBe(
            5,
        );
    });

    it('normalises levels and colours them with the Grafana defaults', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            newestFirst: false,
        });
        expect(model.lines.map((l: { level: string }) => l.level)).toEqual([
            'info',
            'error',
            'debug',
            'warning',
            'critical',
        ]);
        expect(model.lines[1].color.toLowerCase()).toBe('#e24d42');
        expect(model.lines[4].color.toLowerCase()).toBe('#705da0');
    });

    it('applies level colour overrides from the config', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            levelColors: { error: '#000000' },
        });
        const error = model.lines.find(
            (l: { level: string }) => l.level === 'error',
        );
        expect(error.color).toBe('#000000');
    });

    it('binds the long-shape columns by name when the config names none', () => {
        const model = logStreamModel(FIVE_LOGS, { newestFirst: false });
        expect(model.lines[0].line).toBe('GET /api/items 200 12ms');
        expect(model.lines[0].level).toBe('info');
        expect(model.lines[0].labels.pod).toBe('api-1');
    });

    it('parses labels sent as JSON text', () => {
        const model = logStreamModel(
            [
                {
                    ts: '2026-11-08T10:00:00.000Z',
                    line: 'hello',
                    level: 'info',
                    labels: '{"app":"api","region":"synthetic-1"}',
                },
            ],
            LOG_FIELD_IDS,
        );
        expect(model.lines[0].labels).toEqual({
            app: 'api',
            region: 'synthetic-1',
        });
    });

    it('falls back to a level label, then to unknown, when there is no level column', () => {
        const model = logStreamModel(
            [
                {
                    ts: '2026-11-08T10:00:00.000Z',
                    line: 'from label',
                    labels: { level: 'warn' },
                },
                {
                    ts: '2026-11-08T10:00:01.000Z',
                    line: 'from detected_level',
                    labels: { detected_level: 'error' },
                },
                {
                    ts: '2026-11-08T10:00:02.000Z',
                    line: 'no level anywhere',
                    labels: { app: 'api' },
                },
            ],
            {
                lineFieldId: 'app_logs_line',
                timestampFieldId: 'app_logs_timestamp',
                labelsFieldId: 'app_logs_labels',
                newestFirst: false,
            },
        );
        expect(model.lines.map((l: { level: string }) => l.level)).toEqual([
            'warning',
            'error',
            'unknown',
        ]);
    });

    it('carries the display options with their defaults', () => {
        const defaults = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        expect(defaults.wrapLines).toBe(false);
        expect(defaults.showLabels).toBe(false);
        expect(defaults.newestFirst).toBe(true);
        const set = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            wrapLines: true,
            showLabels: true,
        });
        expect(set.wrapLines).toBe(true);
        expect(set.showLabels).toBe(true);
    });

    it('renders empty when there are no rows', () => {
        expect(renderLogStream([], LOG_FIELD_IDS).kind).toBe('empty');
    });
});
