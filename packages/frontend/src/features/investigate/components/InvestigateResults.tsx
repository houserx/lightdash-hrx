import { getTelemetryResultShape } from '@lightdash/common';
import { Box, Group, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useMemo, type FC } from 'react';
import EChartsReact, {
    type EChartsOption,
} from '../../../components/EChartsReactWrapper';
import { toLogEntries, type LogEntry } from '../utils/logLines';
import {
    groupTimeSeries,
    type InvestigateRow,
    type TimeSeriesLine,
} from '../utils/timeSeries';
import classes from './InvestigateResults.module.css';

export type InvestigateResultsProps = {
    columns: string[];
    rows: InvestigateRow[];
    /** Called with a trace id when the user opens a trace from a trace result. */
    onOpenTrace?: (traceId: string) => void;
};

const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const TimeSeriesChart: FC<{ lines: TimeSeriesLine[] }> = ({ lines }) => {
    const option = useMemo<EChartsOption>(
        () => ({
            animation: false,
            tooltip: { trigger: 'axis' },
            legend: { type: 'scroll', bottom: 0 },
            grid: { top: 16, left: 48, right: 24, bottom: 48 },
            xAxis: { type: 'time' },
            yAxis: { type: 'value', scale: true },
            series: lines.map((line) => ({
                name: line.name || 'value',
                type: 'line',
                showSymbol: false,
                connectNulls: false,
                data: line.points,
            })),
        }),
        [lines],
    );
    return (
        <Box
            data-testid="investigate-timeseries"
            data-series-count={String(lines.length)}
        >
            {lines.length === 0 ? (
                <Text c="dimmed" size="sm">
                    No data points
                </Text>
            ) : (
                <EChartsReact
                    option={option}
                    notMerge
                    opts={{ renderer: 'svg' }}
                    className={classes.chart}
                />
            )}
        </Box>
    );
};

const LogList: FC<{ entries: LogEntry[] }> = ({ entries }) => (
    <Box data-testid="investigate-log-list" data-log-count={entries.length}>
        {entries.length === 0 ? (
            <Text c="dimmed" size="sm">
                No log lines
            </Text>
        ) : (
            <ScrollArea.Autosize mah={600}>
                <Stack gap={0}>
                    {entries.map((entry, index) => (
                        <Group
                            // Log rows have no stable id.
                            // eslint-disable-next-line react/no-array-index-key
                            key={index}
                            gap="sm"
                            wrap="nowrap"
                            align="flex-start"
                            className={classes.logLine}
                        >
                            <Text
                                component="time"
                                dateTime={entry.timestamp}
                                size="xs"
                                c="dimmed"
                                ff="monospace"
                                className={classes.logTimestamp}
                            >
                                {entry.timestamp}
                            </Text>
                            <Stack gap={2} miw={0}>
                                <Text
                                    size="xs"
                                    ff="monospace"
                                    className={classes.logMessage}
                                >
                                    {entry.message}
                                </Text>
                                {entry.context && (
                                    <Text size="xs" c="dimmed" ff="monospace">
                                        {entry.context}
                                    </Text>
                                )}
                            </Stack>
                        </Group>
                    ))}
                </Stack>
            </ScrollArea.Autosize>
        )}
    </Box>
);

const ResultTable: FC<{ columns: string[]; rows: InvestigateRow[] }> = ({
    columns,
    rows,
}) => (
    <ScrollArea>
        <Table striped withTableBorder data-testid="investigate-table">
            <Table.Thead>
                <Table.Tr>
                    {columns.map((column) => (
                        <Table.Th key={column}>{column}</Table.Th>
                    ))}
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
                {rows.map((row, index) => (
                    // Result rows have no stable id.
                    // eslint-disable-next-line react/no-array-index-key
                    <Table.Tr key={index}>
                        {columns.map((column) => (
                            <Table.Td key={column}>
                                {formatCell(row[column])}
                            </Table.Td>
                        ))}
                    </Table.Tr>
                ))}
            </Table.Tbody>
        </Table>
    </ScrollArea>
);

/**
 * Renders an Investigate query result by its shape: metric results as a
 * time-series chart with one line per series, log results as a list of lines
 * with their timestamps, anything else as a plain table.
 */
export const InvestigateResults: FC<InvestigateResultsProps> = ({
    columns,
    rows,
}) => {
    const shape = getTelemetryResultShape(columns);
    const lines = useMemo(
        () => (shape === 'metric' ? groupTimeSeries(columns, rows) : []),
        [shape, columns, rows],
    );
    const logEntries = useMemo(
        () => (shape === 'log' ? toLogEntries(columns, rows) : []),
        [shape, columns, rows],
    );
    if (shape === 'metric') {
        return <TimeSeriesChart lines={lines} />;
    }
    if (shape === 'log') {
        return <LogList entries={logEntries} />;
    }
    return <ResultTable columns={columns} rows={rows} />;
};
