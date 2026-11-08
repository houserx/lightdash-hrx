/**
 * Feature viz-cartesian-thresholds-config: cartesian charts carry Grafana
 * style thresholds (steps plus a line / dashed / area style) in their saved
 * config and chart-as-code YAML.
 */
import { describe, expect, it } from 'vitest';
import { chartYaml, defs, validateChartYaml } from './asCode';

const cartesian = (thresholds: string) => `
type: cartesian
config:
  layout:
    xField: app_metrics_timestamp
    yField: [app_metrics_value]
  eChartsConfig:
    series:
      - type: line
        encode:
          xRef: { field: app_metrics_timestamp }
          yRef: { field: app_metrics_value }
${thresholds}`;

describe('cartesian thresholds as code', () => {
    it('control: a cartesian chart without thresholds validates', () => {
        const result = validateChartYaml(chartYaml(cartesian('')));
        expect(result.errors).toBe('[]');
    });

    it('declares thresholds on CartesianChart in the schema', () => {
        expect(defs.CartesianChart?.properties).toHaveProperty('thresholds');
    });

    it.each(['line', 'dashed', 'area', 'line+area', 'dashed+area'])(
        'accepts the %s style',
        (style) => {
            const result = validateChartYaml(
                chartYaml(
                    cartesian(`  thresholds:
    mode: absolute
    style: "${style}"
    steps:
      - { value: null, color: "#73BF69" }
      - { value: 80, color: "#F2495C" }
`),
                ),
            );
            expect(result.errors).toBe('[]');
            expect(result.valid).toBe(true);
        },
    );

    it('rejects an unknown style and a non-numeric step', () => {
        expect(
            validateChartYaml(
                chartYaml(
                    cartesian(`  thresholds:
    style: zigzag
    steps: [{ value: 1, color: "#000000" }]
`),
                ),
            ).valid,
        ).toBe(false);
        expect(
            validateChartYaml(
                chartYaml(
                    cartesian(`  thresholds:
    style: line
    steps: [{ value: high, color: "#000000" }]
`),
                ),
            ).valid,
        ).toBe(false);
    });
});
