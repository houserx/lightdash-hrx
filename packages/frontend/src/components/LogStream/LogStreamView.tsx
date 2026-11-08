import {
    type LogStreamLine,
    type LogStreamModel,
} from '@lightdash/visualization';
import { Box, Center, Group, ScrollArea, Stack, Text } from '@mantine/core';
import {
    measureElement,
    observeElementRect,
    useVirtualizer,
    type Virtualizer,
} from '@tanstack/react-virtual';
import {
    useCallback,
    useRef,
    useState,
    type FC,
    type KeyboardEvent,
} from 'react';
import classes from './LogStreamView.module.css';

type Props = {
    /** The lines to draw, already sorted by `@lightdash/visualization`. */
    model: LogStreamModel;
    /** The view's height in pixels, the count footer included. */
    height: number;
};

const FOOTER_HEIGHT = 28;
/** A collapsed row is one line of text (no wrapping); keep in step with `.header` in the CSS module. */
const ROW_HEIGHT = 24;
/** One label in an expanded row's details; keep in step with `.details` in the CSS module. */
const LABEL_HEIGHT = 20;
/** The details' vertical padding plus the row's bottom border. */
const DETAILS_PADDING = 9;
const OVERSCAN = 20;

/** A row's height before the browser has measured it (and always in jsdom). */
const estimatedRowHeight = (
    line: LogStreamLine | undefined,
    expanded: boolean,
): number => {
    if (!line || !expanded) return ROW_HEIGHT;
    const labelCount = Math.max(Object.keys(line.labels).length, 1);
    return ROW_HEIGHT + DETAILS_PADDING + labelCount * LABEL_HEIGHT;
};

/** The data's own formatting first, else the ISO time, else nothing. */
const timestampText = (line: LogStreamLine): string => {
    if (line.formattedTimestamp !== '') return line.formattedTimestamp;
    if (line.timestamp === null) return '';
    return new Date(line.timestamp).toISOString();
};

const LogStreamDetails: FC<{ line: LogStreamLine }> = ({ line }) => {
    const labels = Object.entries(line.labels);
    return (
        <Box data-testid="log-stream-details" className={classes.details}>
            {labels.length === 0 ? (
                <Text ff="monospace" fz="xs" c="dimmed">
                    No labels
                </Text>
            ) : (
                <dl className={classes.labels}>
                    {labels.map(([key, value]) => (
                        <Box key={key} className={classes.label}>
                            <Text
                                component="dt"
                                ff="monospace"
                                fz="xs"
                                c="dimmed"
                            >
                                {key}
                            </Text>
                            <Text component="dd" ff="monospace" fz="xs">
                                {value}
                            </Text>
                        </Box>
                    ))}
                </dl>
            )}
        </Box>
    );
};

type RowProps = {
    line: LogStreamLine;
    index: number;
    start: number;
    expanded: boolean;
    onToggle: (id: string) => void;
    measureRef: (node: Element | null) => void;
};

const LogStreamRow: FC<RowProps> = ({
    line,
    index,
    start,
    expanded,
    onToggle,
    measureRef,
}) => {
    const toggle = () => onToggle(line.id);
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
    };
    return (
        <Box
            ref={measureRef}
            data-index={index}
            data-testid="log-stream-row"
            data-level={line.level}
            className={classes.row}
            style={{ '--log-row-start': `${start}px` }}
        >
            <Group
                className={classes.header}
                gap="sm"
                wrap="nowrap"
                align="flex-start"
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={toggle}
                onKeyDown={onKeyDown}
            >
                <Box
                    data-testid="log-stream-level-bar"
                    className={classes.levelBar}
                    bg={line.color}
                    title={line.level}
                />
                <Text
                    data-testid="log-stream-timestamp"
                    className={classes.timestamp}
                    ff="monospace"
                    fz="xs"
                    c="dimmed"
                >
                    {timestampText(line)}
                </Text>
                <Text
                    data-testid="log-stream-line"
                    className={classes.line}
                    ff="monospace"
                    fz="xs"
                >
                    {line.line}
                </Text>
            </Group>
            {expanded && <LogStreamDetails line={line} />}
        </Box>
    );
};

/**
 * A log stream: one row per line, newest or oldest first as the model says.
 * Only the rows in view (plus overscan) are in the page. Clicking a row
 * toggles its details: every label as key and value.
 */
export const LogStreamView: FC<Props> = ({ model, height }) => {
    const total = model.lines.length;
    const viewportHeight = Math.max(height - FOOTER_HEIGHT, 0);
    const viewportRef = useRef<HTMLDivElement>(null);
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const toggleRow = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }, []);
    const estimateSize = (index: number) => {
        const line = model.lines[index];
        return estimatedRowHeight(line, !!line && expandedIds.has(line.id));
    };
    // Measure the viewport as usual, but fall back to the size the props
    // give it while the element has no layout yet (first paint, jsdom).
    const observeViewport = useCallback(
        (
            instance: Virtualizer<HTMLDivElement, Element>,
            onChange: (rect: { width: number; height: number }) => void,
        ) =>
            observeElementRect(instance, (rect) =>
                onChange(
                    rect.height > 0
                        ? rect
                        : { width: rect.width, height: viewportHeight },
                ),
            ),
        [viewportHeight],
    );
    const virtualizer = useVirtualizer({
        count: total,
        getScrollElement: () => viewportRef.current,
        estimateSize,
        // Rows grow when expanded, so measure them; an element without
        // layout (jsdom) measures 0, so keep the estimate then.
        measureElement: (element, entry, instance) => {
            const size = measureElement(element, entry, instance);
            return size > 0
                ? size
                : estimateSize(instance.indexFromElement(element));
        },
        getItemKey: (index) => model.lines[index]?.id ?? index,
        initialRect: { width: 0, height: viewportHeight },
        observeElementRect: observeViewport,
        overscan: OVERSCAN,
    });
    const lineCount = `${total.toLocaleString()} of ${total.toLocaleString()} lines`;

    return (
        <Stack gap={0} h={height} className={classes.root}>
            {total === 0 ? (
                <Center flex={1}>
                    <Text c="dimmed" fz="sm">
                        No log lines
                    </Text>
                </Center>
            ) : (
                <ScrollArea flex={1} type="auto" viewportRef={viewportRef}>
                    <Box h={virtualizer.getTotalSize()} pos="relative">
                        {virtualizer.getVirtualItems().map((item) => {
                            const line = model.lines[item.index];
                            if (!line) return null;
                            return (
                                <LogStreamRow
                                    key={item.key}
                                    line={line}
                                    index={item.index}
                                    start={item.start}
                                    expanded={expandedIds.has(line.id)}
                                    onToggle={toggleRow}
                                    measureRef={virtualizer.measureElement}
                                />
                            );
                        })}
                    </Box>
                </ScrollArea>
            )}
            <Box h={FOOTER_HEIGHT} className={classes.footer}>
                <Text fz="xs" c="dimmed">
                    {lineCount}
                </Text>
            </Box>
        </Stack>
    );
};
