/**
 * Feature viz-log-stream-as-code: a log stream chart can be written as
 * chart-as-code YAML, and the published JSON schema validates its config.
 */
import { describe, expect, it } from 'vitest';
import { chartYaml, defs, validateChartYaml } from './asCode';

describe('log_stream chart-as-code', () => {
    it('control: a table chart validates (the harness itself works)', () => {
        const result = validateChartYaml(chartYaml('type: table'));
        expect(result.errors).toBe('[]');
        expect(result.valid).toBe(true);
    });

    it('accepts a log_stream chart with its full config', () => {
        const result = validateChartYaml(
            chartYaml(`
type: log_stream
config:
  lineFieldId: app_logs_line
  timestampFieldId: app_logs_timestamp
  levelFieldId: app_logs_level
  labelsFieldId: app_logs_labels
  wrapLines: true
  newestFirst: true
  showLabels: false
  levelColors:
    error: "#ff0000"
    warning: "#ffaa00"
`),
        );
        expect(result.errors).toBe('[]');
        expect(result.valid).toBe(true);
    });

    it('accepts a log_stream chart with no config (defaults apply)', () => {
        expect(validateChartYaml(chartYaml('type: log_stream')).valid).toBe(
            true,
        );
    });

    it('describes every config field in the schema', () => {
        const props = Object.keys(defs.LogStreamChart?.properties ?? {});
        expect(props.sort()).toEqual(
            [
                'labelsFieldId',
                'levelColors',
                'levelFieldId',
                'lineFieldId',
                'newestFirst',
                'showLabels',
                'timestampFieldId',
                'wrapLines',
            ].sort(),
        );
    });

    it('rejects a config with the wrong value types', () => {
        expect(
            validateChartYaml(
                chartYaml(`
type: log_stream
config:
  wrapLines: "yes"
`),
            ).valid,
        ).toBe(false);
        expect(
            validateChartYaml(
                chartYaml(`
type: log_stream
config:
  lineFieldId: 12
`),
            ).valid,
        ).toBe(false);
    });
});
