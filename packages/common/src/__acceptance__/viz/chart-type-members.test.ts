/**
 * Feature viz-chart-type-members: `log_stream` and `trace_waterfall` are
 * native Lightdash chart types, with a ChartKind each that round-trips.
 */
import { describe, expect, it } from 'vitest';
import { ChartKind, ChartType, getChartKind, getChartType } from '../../index';

describe('native telemetry chart types', () => {
    it('adds ChartType members with the stored values', () => {
        expect(ChartType.LOG_STREAM).toBe('log_stream');
        expect(ChartType.TRACE_WATERFALL).toBe('trace_waterfall');
    });

    it('adds ChartKind members with the same values', () => {
        expect(ChartKind.LOG_STREAM).toBe('log_stream');
        expect(ChartKind.TRACE_WATERFALL).toBe('trace_waterfall');
    });

    it('maps kind to type and type to kind', () => {
        expect(getChartType(ChartKind.LOG_STREAM)).toBe(ChartType.LOG_STREAM);
        expect(getChartType(ChartKind.TRACE_WATERFALL)).toBe(
            ChartType.TRACE_WATERFALL,
        );
        expect(getChartKind(ChartType.LOG_STREAM, undefined)).toBe(
            ChartKind.LOG_STREAM,
        );
        expect(getChartKind(ChartType.TRACE_WATERFALL, undefined)).toBe(
            ChartKind.TRACE_WATERFALL,
        );
    });

    it('leaves the existing types alone', () => {
        expect(getChartType(ChartKind.SANKEY)).toBe(ChartType.SANKEY);
        expect(getChartType(undefined)).toBe(ChartType.CARTESIAN);
    });
});
