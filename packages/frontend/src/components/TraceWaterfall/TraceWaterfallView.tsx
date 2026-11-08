import {
    type TraceWaterfallModel,
    type TraceWaterfallSpan,
} from '@lightdash/visualization';
import {
    ActionIcon,
    Box,
    Center,
    Group,
    ScrollArea,
    Stack,
    Text,
    UnstyledButton,
} from '@mantine/core';
import {
    IconAlertTriangle,
    IconChevronDown,
    IconChevronRight,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useMemo, useState, type FC } from 'react';
import MantineIcon from '../common/MantineIcon';
import { SpanDetailDrawer } from './SpanDetailDrawer';
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

/** The trace's services in order of first appearance, each with its colour. */
const servicesOf = (
    spans: TraceWaterfallSpan[],
): { service: string; color: string }[] => {
    const colors = new Map<string, string>();
    for (const span of spans) {
        if (!colors.has(span.service)) colors.set(span.service, span.color);
    }
    return [...colors].map(([service, color]) => ({ service, color }));
};

const ServiceLegend: FC<{ spans: TraceWaterfallSpan[] }> = ({ spans }) => (
    <Group
        data-testid="trace-service-legend"
        aria-label="Services"
        gap="sm"
        className={classes.legend}
    >
        {servicesOf(spans).map(({ service, color }) => (
            <Group
                key={service}
                gap={4}
                wrap="nowrap"
                data-testid="trace-service-legend-item"
                data-service={service}
            >
                <Box
                    className={classes.swatch}
                    // The swatch shows the service's colour, which is data.
                    // oxlint-disable-next-line lightdash-ui/no-inline-style-prop
                    style={{ backgroundColor: color }}
                />
                <Text fz="xs">{service || '(no service)'}</Text>
            </Group>
        ))}
    </Group>
);

/** A span with its place in the drawn tree. */
type SpanRowItem = {
    span: TraceWaterfallSpan;
    hasChildren: boolean;
    isCollapsed: boolean;
};

/**
 * The rows to draw: the spans in the model's depth-first order, minus the
 * subtree of every collapsed span. In that order a span's subtree is the run
 * of spans right after it that are deeper than it.
 */
const visibleRows = (
    spans: TraceWaterfallSpan[],
    collapsed: ReadonlySet<string>,
): SpanRowItem[] => {
    const rows: SpanRowItem[] = [];
    let hiddenBelowDepth: number | null = null;
    spans.forEach((span, index) => {
        if (hiddenBelowDepth !== null && span.depth > hiddenBelowDepth) return;
        hiddenBelowDepth = null;
        const next = spans[index + 1];
        const hasChildren = next !== undefined && next.depth > span.depth;
        const isCollapsed = hasChildren && collapsed.has(span.spanId);
        if (isCollapsed) hiddenBelowDepth = span.depth;
        rows.push({ span, hasChildren, isCollapsed });
    });
    return rows;
};

const SpanRow: FC<
    SpanRowItem & {
        traceDurationMs: number;
        onToggle: (spanId: string) => void;
        onSelect: (span: TraceWaterfallSpan) => void;
    }
> = ({
    span,
    hasChildren,
    isCollapsed,
    traceDurationMs,
    onToggle,
    onSelect,
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
                {hasChildren ? (
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="xs"
                        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${
                            span.name
                        }`}
                        aria-expanded={!isCollapsed}
                        onClick={() => onToggle(span.spanId)}
                    >
                        <MantineIcon
                            icon={
                                isCollapsed ? IconChevronRight : IconChevronDown
                            }
                            size="sm"
                        />
                    </ActionIcon>
                ) : (
                    <Box className={classes.togglePlaceholder} />
                )}
                {isError && (
                    <MantineIcon
                        icon={IconAlertTriangle}
                        color="red"
                        size="sm"
                        aria-label="Error"
                    />
                )}
                <UnstyledButton
                    aria-label={`Show details of ${span.name}`}
                    className={classes.nameButton}
                    onClick={() => onSelect(span)}
                >
                    <Text fz="xs" fw={500} truncate className={classes.name}>
                        {span.name}
                    </Text>
                </UnstyledButton>
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
 * trace's duration. Bars take their service's colour, and a legend above
 * names each service in it. Spans whose status is an error are marked in red.
 * A span with children has a Collapse / Expand button that hides or shows
 * its whole subtree. Clicking a span's name opens a drawer with its
 * details and every attribute.
 */
export const TraceWaterfallView: FC<Props> = ({ model }) => {
    const trace = model.traces[0];
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const toggle = useCallback((spanId: string) => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (!next.delete(spanId)) next.add(spanId);
            return next;
        });
    }, []);
    const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
    const selectSpan = useCallback(
        (span: TraceWaterfallSpan) => setSelectedSpanId(span.spanId),
        [],
    );
    const selectedSpan =
        trace?.spans.find((span) => span.spanId === selectedSpanId) ?? null;
    const rows = useMemo(
        () => (trace ? visibleRows(trace.spans, collapsed) : []),
        [trace, collapsed],
    );
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
            <ServiceLegend spans={trace.spans} />
            <TimeAxis durationMs={trace.durationMs} />
            <ScrollArea flex={1} type="auto">
                {rows.map((row) => (
                    <SpanRow
                        key={row.span.spanId}
                        {...row}
                        traceDurationMs={trace.durationMs}
                        onToggle={toggle}
                        onSelect={selectSpan}
                    />
                ))}
            </ScrollArea>
            <SpanDetailDrawer
                span={selectedSpan}
                onClose={() => setSelectedSpanId(null)}
            />
        </Stack>
    );
};
