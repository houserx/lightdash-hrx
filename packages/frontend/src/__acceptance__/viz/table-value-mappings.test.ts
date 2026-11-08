/**
 * Feature viz-table-value-mappings: a table column's value mappings replace
 * the displayed text of matching cells (Grafana "value mappings").
 */
import { ChartType, type ChartConfig } from '@lightdash/common';
import { renderChart } from '@lightdash/visualization';
import { describe, expect, it } from 'vitest';
import { metricData } from './fixtures';

const table = (columns: Record<string, unknown>): ChartConfig =>
    ({ type: ChartType.TABLE, config: { columns } }) as unknown as ChartConfig;

const data = metricData([
    [0, 5],
    [1, 15],
    [2, 25],
]);

describe('table value mappings', () => {
    it('maps cell text in the table model', () => {
        const rendered = renderChart(
            {
                chartConfig: table({
                    m_status: {
                        valueMappings: [
                            {
                                type: 'value',
                                options: {
                                    '0': { text: 'Down', color: 'red', index: 0 },
                                    '1': { text: 'Up', color: 'green', index: 1 },
                                },
                            },
                        ],
                    },
                    m_value: {
                        valueMappings: [
                            {
                                type: 'range',
                                options: {
                                    from: 10,
                                    to: 20,
                                    result: { text: 'Busy', index: 0 },
                                },
                            },
                        ],
                    },
                }),
            },
            data,
        );
        expect(rendered.kind).toBe('table');
        const rows = (rendered as { model: { rows: any[] } }).model.rows;
        expect(rows.map((r) => r.m_status.value.formatted)).toEqual([
            'Down',
            'Up',
            'Down',
        ]);
        expect(rows.map((r) => r.m_value.value.formatted)).toEqual([
            '5',
            'Busy',
            '25',
        ]);
        // the raw values are untouched, so sorting and export still work
        expect(rows.map((r) => r.m_status.value.raw)).toEqual([0, 1, 0]);
    });

    it('control: a table without mappings shows the formatted values', () => {
        const rendered = renderChart({ chartConfig: table({}) }, data);
        expect(rendered.kind).toBe('table');
        const rows = (rendered as { model: { rows: any[] } }).model.rows;
        expect(rows.map((r) => r.m_value.value.formatted)).toEqual([
            '5',
            '15',
            '25',
        ]);
    });
});
