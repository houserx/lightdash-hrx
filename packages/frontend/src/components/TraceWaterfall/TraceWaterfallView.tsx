import {
    type TraceWaterfallModel,
    type TraceWaterfallSpan,
} from '@lightdash/visualization';
import { Box, Center, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import clsx from 'clsx';
import { type FC } from 'react';
import MantineIcon from '../common/MantineIcon';
import {
    formatDurationMs,
    isErrorStatus,
    percentOf,
} from './traceWaterfallFormat';
import classes from './TraceWaterfallView.module.css';

type Props = {
    /** The traces to draw, already placed by `@lightdash/visualization`. */
    model: TraceWaterfallModel;
};

/** Where the time axis puts its labels, as shares of the trace duration. */
const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1];

const TimeAxis: FC<{ durationMs: number }> = ({ durationMs }) => (
    <Group gap={0} wrap="nowrap" className={classes.axisRow}>
        <Box className={classes.labelColumn}>
            <Text fz="xs" c="dimmed">
                Span
            </Text>
        </Box>
        <Box data-testid="trace-time-axis" className={classes.axis}>
            {AXIS_TICKS.map((tick) => (
                <Text
                    key={tick}
                    fz="xs"
                    c="dimmed"
                    className={clsx(
                        classes.tick,
                        tick === 0 && classes.tickStart,
                        tick === 1 && classes.tickEnd,
                    )}
                    style={{ '--tick-left': `${tick * 100}%` }}
                >
                    {formatDurationMs(tick * durationMs)}
                </Text>
            ))}
        </Box>
    </Group>
);

const SpanRow: FC<{ span: TraceWaterfallSpan; traceDurationMs: number }> = ({
    span,
    traceDurationMs,
}) => {
    const isError = isErrorStatus(span.status);
    const duration = formatDurationMs(span.durationMs);
    return (
        <Group
            data-testid="trace-span-row"
            data-span-id={span.spanId}
            data-depth={span.depth}
            data-status={isError ? 'error' : 'ok'}
            gap={0}
            wrap="nowrap"
            className={clsx(classes.row, isError && classes.errorRow)}
        >
            <Group
                gap={6}
                wrap="nowrap"
                className={classes.labelColumn}
                style={{ '--span-depth': span.depth }}
            >
                {isError && (
                    <MantineIcon
                        icon={IconAlertTriangle}
                        color="red"
                        size="sm"
                        aria-label="Error"
                    />
                )}
                <Text fz="xs" fw={500} truncate className={classes.name}>
                    {span.name}
                </Text>
                <Text fz="xs" c="dimmed" truncate className={classes.service}>
                    {span.service}
                </Text>
            </Group>
            <Box className={classes.track}>
                <Box
                    data-testid="trace-span-bar"
                    className={clsx(classes.bar, isError && classes.errorBar)}
                    title={`${span.name} · ${duration}`}
                    // Each bar's place, length and service colour are data, so they
                    // ride on the element itself.
                    // oxlint-disable-next-line lightdash-ui/no-inline-style-prop
                    style={{
                        left: percentOf(span.offsetMs, traceDurationMs),
                        width: percentOf(span.durationMs, traceDurationMs),
                        backgroundColor: span.color,
                    }}
                />
            </Box>
            <Text fz="xs" c="dimmed" className={classes.duration}>
                {duration}
            </Text>
        </Group>
    );
};

/**
 * A trace waterfall: one row per span of the first trace, in the model's
 * tree order and indented by depth, each with its name, service and
 * duration and a bar placed on a time axis that runs from 0 ms to the
 * trace's duration. Spans whose status is an error are marked in red.
 */
export const TraceWaterfallView: FC<Props> = ({ model }) => {
    const trace = model.traces[0];
    if (!trace || trace.spans.length === 0) {
        return (
            <Center h="100%" mih={80}>
                <Text c="dimmed" fz="sm">
                    No spans
                </Text>
            </Center>
        );
    }
    return (
        <Stack gap={0} h="100%" className={classes.root}>
            <TimeAxis durationMs={trace.durationMs} />
            <ScrollArea flex={1} type="auto">
                {trace.spans.map((span) => (
                    <SpanRow
                        key={span.spanId}
                        span={span}
                        traceDurationMs={trace.durationMs}
                    />
                ))}
            </ScrollArea>
        </Stack>
    );
};
