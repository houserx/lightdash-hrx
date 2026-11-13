/**
 * Shared helpers for the viz line's chart-as-code checks: a chart YAML file
 * as `lightdash download` writes it, validated with the same JSON schema the
 * CLI and the backend use (`chart-as-code-1.0.json`).
 */
import Ajv from 'ajv';
import { parse } from 'yaml';
import { chartAsCodeSchema } from '../../schemas/chartAsCodeSchema';

const validateChart = new Ajv({
    strict: false,
    validateFormats: false,
    allErrors: true,
}).compile({
    $schema: chartAsCodeSchema.$schema,
    $defs: chartAsCodeSchema.$defs,
    ...chartAsCodeSchema.$defs.ChartAsCode,
});

export const chartYaml = (chartConfigYaml: string): string =>
    [
        'version: 1',
        'name: Synthetic telemetry chart',
        'slug: synthetic-telemetry-chart',
        'spaceSlug: operations',
        'tableName: app_logs',
        'metricQuery:',
        '  exploreName: app_logs',
        '  dimensions: [app_logs_timestamp, app_logs_line]',
        '  metrics: []',
        '  filters: {}',
        '  sorts: []',
        '  limit: 500',
        '  tableCalculations: []',
        'chartConfig:',
        ...chartConfigYaml
            .trim()
            .split('\n')
            .map((line) => `  ${line}`),
        '',
    ].join('\n');

export const validateChartYaml = (
    yamlText: string,
): { valid: boolean; errors: string } => {
    const doc = parse(yamlText);
    const valid = validateChart(doc) as boolean;
    return { valid, errors: JSON.stringify(validateChart.errors ?? []) };
};

export const defs = chartAsCodeSchema.$defs as Record<
    string,
    { properties?: Record<string, unknown> }
>;
