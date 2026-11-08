import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { toLogEntries } from '../utils/logLines';
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

describe('toLogEntries', () => {
    it('keeps the row order and reads logql and cloudwatch_logs columns', () => {
        expect(
            toLogEntries(
                ['TIMESTAMP', 'LINE', 'LABELS', 'STREAM'],
                [
                    {
                        TIMESTAMP: Date.parse('2026-11-08T10:00:01.000Z'),
                        LINE: 'second',
                        LABELS: { app: 'api' },
                        STREAM: '{app="api"}',
                    },
                    {
                        TIMESTAMP: 'not a time',
                        LINE: 'first',
                        LABELS: null,
                        STREAM: null,
                    },
                ],
            ),
        ).toEqual([
            {
                timestamp: '2026-11-08T10:00:01.000Z',
                message: 'second',
                context: '{app="api"}',
            },
            { timestamp: 'not a time', message: 'first', context: '' },
        ]);
        expect(
            toLogEntries(
                ['timestamp', 'message', 'fields'],
                [
                    {
                        timestamp: new Date('2026-11-08T10:00:00.000Z'),
                        message: 'timed out',
                        fields: { '@logStream': 'abc' },
                    },
                ],
            ),
        ).toEqual([
            {
                timestamp: '2026-11-08T10:00:00.000Z',
                message: 'timed out',
                context: '{"@logStream":"abc"}',
            },
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

    it('lists log lines with their timestamps', () => {
        renderResults({
            columns: ['timestamp', 'line', 'labels', 'stream'],
            rows: [
                {
                    timestamp: '2026-11-08T10:00:01.000Z',
                    line: 'level=error msg="sync failed"',
                    labels: '{"app":"api"}',
                    stream: '{app="api"}',
                },
            ],
        });
        const list = screen.getByTestId('investigate-log-list');
        expect(list).toHaveAttribute('data-log-count', '1');
        expect(list.querySelector('time')).toHaveAttribute(
            'datetime',
            '2026-11-08T10:00:01.000Z',
        );
        expect(list.textContent).toContain('level=error msg="sync failed"');
        expect(list.textContent).toContain('{app="api"}');
        expect(screen.queryByTestId('investigate-table')).toBeNull();
    });

    it('says so when a log result has no lines', () => {
        renderResults({
            columns: ['timestamp', 'message', 'fields'],
            rows: [],
        });
        expect(
            screen.getByTestId('investigate-log-list').textContent,
        ).toContain('No log lines');
    });
});
