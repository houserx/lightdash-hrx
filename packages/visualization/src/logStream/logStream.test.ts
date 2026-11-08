import {
    ChartType,
    DimensionType,
    FieldType,
    type ResultRow,
} from '@lightdash/common';
import { describe, expect, test } from 'vitest';
import { type ChartData } from '../chartData';
import { renderChart } from '../render';
import { parseLogLabels } from './model';

const cell = (raw: unknown) => ({
    value: { raw, formatted: raw === null ? '' : String(raw) },
});

const dim = (label: string, type = DimensionType.STRING) => ({
    fieldType: FieldType.DIMENSION,
    type,
    label,
});

const render = (data: ChartData, config: Record<string, unknown> = {}) =>
    renderChart({ chartConfig: { type: ChartType.LOG_STREAM, config } }, data);

const modelOf = (data: ChartData, config: Record<string, unknown> = {}) => {
    const rendered = render(data, config);
    if (rendered.kind !== 'logStream') throw new Error(rendered.kind);
    return rendered.model;
};

// The bare columns of a SQL runner query over `logql()`.
const logqlData = (rows: ResultRow[]): ChartData => ({
    rows,
    fields: {
        timestamp: dim('timestamp', DimensionType.TIMESTAMP),
        line: dim('line'),
        labels: dim('labels'),
        stream: dim('stream'),
    },
});

describe('log stream', () => {
    test('binds the bare logql() columns and reads the level from labels', () => {
        const model = modelOf(
            logqlData([
                {
                    timestamp: cell('2026-11-08T10:00:00.000Z'),
                    line: cell('synthetic hello'),
                    labels: cell('{"level":"ERR","app":"api"}'),
                    stream: cell('{app="api"}'),
                },
            ]),
        );
        expect(model.lines[0]).toMatchObject({
            id: '0',
            line: 'synthetic hello',
            timestamp: Date.UTC(2026, 10, 8, 10),
            level: 'error',
            color: '#e24d42',
            labels: { level: 'ERR', app: 'api' },
        });
    });

    test('binds cloudwatch_logs() message and fields columns', () => {
        const model = modelOf({
            rows: [
                {
                    logs_timestamp: cell('2026-11-08T10:00:00.000Z'),
                    logs_message: cell('synthetic event'),
                    logs_fields: cell({ level: 'warn' }),
                },
            ],
            fields: {
                logs_timestamp: dim('Timestamp', DimensionType.TIMESTAMP),
                logs_message: dim('Message'),
                logs_fields: dim('Fields'),
            },
        });
        expect(model.lines[0]).toMatchObject({
            line: 'synthetic event',
            level: 'warning',
        });
    });

    test('rebinds a configured field the data no longer has', () => {
        const model = modelOf(
            logqlData([{ line: cell('kept'), timestamp: cell(null) }]),
            { lineFieldId: 'gone_line' },
        );
        expect(model.lines[0].line).toBe('kept');
        expect(model.lines[0].timestamp).toBeNull();
    });

    test('a configured field wins over the column found by name', () => {
        const model = modelOf(
            logqlData([{ line: cell('by name'), stream: cell('configured') }]),
            { lineFieldId: 'stream' },
        );
        expect(model.lines[0].line).toBe('configured');
    });

    test('is incomplete without a line column, and empty without rows', () => {
        expect(
            render({
                rows: [{ other: cell('x') }],
                fields: { other: dim('Other') },
            }),
        ).toMatchObject({ kind: 'empty', reason: 'incompleteConfig' });
        expect(render(logqlData([]))).toMatchObject({
            kind: 'empty',
            chartType: ChartType.LOG_STREAM,
            reason: 'noRows',
        });
    });

    test('labels that are not a JSON object are none', () => {
        expect(parseLogLabels('not json')).toEqual({});
        expect(parseLogLabels('[1,2]')).toEqual({});
        expect(parseLogLabels(null)).toEqual({});
        expect(parseLogLabels({ n: 1, ok: true })).toEqual({
            n: '1',
            ok: 'true',
        });
    });

    test('sorts by time, newest first by default, untimed lines last', () => {
        const rows = [
            { timestamp: cell('2026-11-08T10:00:02.000Z'), line: cell('b') },
            { timestamp: cell(null), line: cell('none') },
            { timestamp: cell('2026-11-08T10:00:01.000Z'), line: cell('a') },
            { timestamp: cell('2026-11-08T10:00:03.000Z'), line: cell('c') },
        ];
        const order = (config: Record<string, unknown> = {}) =>
            modelOf(logqlData(rows), config).lines.map((l) => l.line);
        expect(order()).toEqual(['c', 'b', 'a', 'none']);
        expect(order({ newestFirst: false })).toEqual(['a', 'b', 'c', 'none']);
    });
});
