// ldq-investigate-result-shape: Investigate picks a renderer from the column shape that
// the §1.1 table functions return.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('getTelemetryResultShape', () => {
    it('detects metric shapes (promql, logql_metric, cloudwatch)', () => {
        expect(
            common.getTelemetryResultShape([
                'timestamp',
                'value',
                'labels',
                'series',
            ]),
        ).toBe('metric');
    });

    it('detects log shapes (logql and cloudwatch_logs)', () => {
        expect(
            common.getTelemetryResultShape([
                'timestamp',
                'line',
                'labels',
                'stream',
            ]),
        ).toBe('log');
        expect(
            common.getTelemetryResultShape(['timestamp', 'message', 'fields']),
        ).toBe('log');
    });

    it('detects trace shapes (traceql and trace)', () => {
        expect(
            common.getTelemetryResultShape([
                'trace_id',
                'root_service',
                'root_name',
                'start',
                'duration_ms',
                'span_count',
            ]),
        ).toBe('trace');
        expect(
            common.getTelemetryResultShape([
                'trace_id',
                'span_id',
                'parent_span_id',
                'service',
                'name',
                'start',
                'duration_ms',
                'status',
                'attributes',
            ]),
        ).toBe('trace');
    });

    it('falls back to a table for anything else', () => {
        expect(common.getTelemetryResultShape(['id', 'status'])).toBe('table');
        expect(common.getTelemetryResultShape(['timestamp', 'count'])).toBe(
            'table',
        );
    });
});
