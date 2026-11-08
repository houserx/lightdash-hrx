import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { groupTimeSeries } from '../utils/timeSeries';
import { InvestigateResults } from './InvestigateResults';

const columns = ['timestamp', 'value', 'labels', 'series'];
const rows = [
    {
        timestamp: '2026-11-08T10:00:30.000Z',
        value: '2',
        labels: '{"status":"200"}',
        series: '{status="200"}',
    },
    {
        timestamp: '2026-11-08T10:00:00.000Z',
        value: 1,
        labels: '{"status":"200"}',
        series: '{status="200"}',
    },
    {
        timestamp: '2026-11-08T10:00:00.000Z',
        value: 'NaN',
        labels: '{"status":"500"}',
        series: '{status="500"}',
    },
];

const renderResults = (props: Parameters<typeof InvestigateResults>[0]) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            <InvestigateResults {...props} />
        </MantineProvider>,
    );

describe('groupTimeSeries', () => {
    it('makes one line per series sorted by time with numeric values', () => {
        expect(groupTimeSeries(columns, rows)).toEqual([
            {
                name: '{status="200"}',
                points: [
                    [Date.parse('2026-11-08T10:00:00.000Z'), 1],
                    [Date.parse('2026-11-08T10:00:30.000Z'), 2],
                ],
            },
            {
                name: '{status="500"}',
                points: [[Date.parse('2026-11-08T10:00:00.000Z'), null]],
            },
        ]);
    });

    it('falls back to labels and matches upper-cased columns', () => {
        const lines = groupTimeSeries(
            ['TIMESTAMP', 'VALUE', 'LABELS'],
            [
                { TIMESTAMP: 0, VALUE: 1, LABELS: '{"a":"1"}' },
                { TIMESTAMP: 0, VALUE: 1, LABELS: '{"a":"2"}' },
            ],
        );
        expect(lines.map((line) => line.name)).toEqual([
            '{"a":"1"}',
            '{"a":"2"}',
        ]);
    });
});

describe('InvestigateResults', () => {
    it('draws one chart line per series', () => {
        renderResults({ columns, rows });
        const chart = screen.getByTestId('investigate-timeseries');
        expect(chart).toHaveAttribute('data-series-count', '2');
        expect(chart.querySelector('svg')).not.toBeNull();
        expect(screen.queryByTestId('investigate-table')).toBeNull();
    });

    it('says so when a metric result has no points', () => {
        renderResults({ columns, rows: [] });
        expect(
            screen.getByTestId('investigate-timeseries').textContent,
        ).toContain('No data points');
    });

    it('shows other shapes as a plain table', () => {
        renderResults({
            columns: ['id', 'status'],
            rows: [{ id: 42, status: 'stuck' }],
        });
        expect(screen.getByTestId('investigate-table')).toBeInTheDocument();
        expect(screen.getByText('stuck')).toBeInTheDocument();
        expect(screen.queryByTestId('investigate-timeseries')).toBeNull();
    });
});
