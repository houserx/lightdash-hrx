/**
 * Feature viz-table-value-mappings-config: a table column carries Grafana
 * value mappings in its saved config and chart-as-code YAML.
 */
import { describe, expect, it } from 'vitest';
import { chartYaml, defs, validateChartYaml } from './asCode';

const table = (columns: string) => `
type: table
config:
  columns:
    app_metrics_value:
      visible: true
${columns}`;

describe('table value mappings as code', () => {
    it('control: a table with column properties validates', () => {
        expect(validateChartYaml(chartYaml(table(''))).errors).toBe('[]');
    });

    it('declares valueMappings on ColumnProperties in the schema', () => {
        expect(defs.ColumnProperties?.properties).toHaveProperty(
            'valueMappings',
        );
    });

    it('accepts value, range, regex and special mappings', () => {
        const result = validateChartYaml(
            chartYaml(
                table(`      valueMappings:
        - type: value
          options:
            "0": { text: Down, color: red, index: 0 }
        - type: range
          options: { from: 10, to: 20, result: { text: Busy, index: 1 } }
        - type: regex
          options: { pattern: "^api-", result: { text: API, index: 2 } }
        - type: special
          options: { match: "null", result: { text: N/A, index: 3 } }
`),
            ),
        );
        expect(result.errors).toBe('[]');
        expect(result.valid).toBe(true);
    });

    it('rejects an unknown mapping type', () => {
        expect(
            validateChartYaml(
                chartYaml(
                    table(`      valueMappings:
        - type: bogus
          options: {}
`),
                ),
            ).valid,
        ).toBe(false);
    });
});
