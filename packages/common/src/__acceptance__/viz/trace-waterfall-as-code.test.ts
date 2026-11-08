/**
 * Feature viz-trace-waterfall-as-code: a trace waterfall chart can be
 * written as chart-as-code YAML, and the JSON schema validates its config.
 */
import { describe, expect, it } from 'vitest';
import { chartYaml, defs, validateChartYaml } from './asCode';

describe('trace_waterfall chart-as-code', () => {
    it('control: a table chart validates (the harness itself works)', () => {
        expect(validateChartYaml(chartYaml('type: table')).valid).toBe(true);
    });

    it('accepts a trace_waterfall chart with every span field bound', () => {
        const result = validateChartYaml(
            chartYaml(`
type: trace_waterfall
config:
  traceIdFieldId: spans_trace_id
  spanIdFieldId: spans_span_id
  parentSpanIdFieldId: spans_parent_span_id
  serviceFieldId: spans_service
  nameFieldId: spans_name
  startFieldId: spans_start
  durationMsFieldId: spans_duration_ms
  statusFieldId: spans_status
  attributesFieldId: spans_attributes
`),
        );
        expect(result.errors).toBe('[]');
        expect(result.valid).toBe(true);
    });

    it('accepts a trace_waterfall chart with no config', () => {
        expect(
            validateChartYaml(chartYaml('type: trace_waterfall')).valid,
        ).toBe(true);
    });

    it('describes every span field in the schema', () => {
        const props = Object.keys(defs.TraceWaterfallChart?.properties ?? {});
        expect(props).toEqual(
            expect.arrayContaining([
                'traceIdFieldId',
                'spanIdFieldId',
                'parentSpanIdFieldId',
                'serviceFieldId',
                'nameFieldId',
                'startFieldId',
                'durationMsFieldId',
                'statusFieldId',
                'attributesFieldId',
            ]),
        );
    });

    it('rejects a field id that is not a string', () => {
        expect(
            validateChartYaml(
                chartYaml(`
type: trace_waterfall
config:
  spanIdFieldId: [a, b]
`),
            ).valid,
        ).toBe(false);
    });
});
