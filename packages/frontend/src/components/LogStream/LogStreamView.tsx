import {
    type LogStreamLine,
    type LogStreamModel,
} from '@lightdash/visualization';
import {
    Box,
    Center,
    CloseButton,
    Group,
    ScrollArea,
    Stack,
    Text,
    TextInput,
} from '@mantine/core';
import {
    measureElement,
    observeElementRect,
    useVirtualizer,
    type Virtualizer,
} from '@tanstack/react-virtual';
import clsx from 'clsx';
import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type FC,
    type KeyboardEvent,
} from 'react';
import classes from './LogStreamView.module.css';

type Props = {
    /** The lines to draw, already sorted by `@lightdash/visualization`. */
    model: LogStreamModel;
    /** The view's height in pixels, the filter box and count footer included. */
    height: number;
};

const FOOTER_HEIGHT = 28;
/** The filter box above the lines; keep in step with `.toolbar` in the CSS module. */
const TOOLBAR_HEIGHT = 36;
/** A collapsed, unwrapped row is one line of text; keep in step with `.header` in the CSS module. Wrapped rows are measured. */
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

/** The lines whose text contains the filter, ignoring case; all of them for a blank filter. */
const filterLines = (
    lines: LogStreamLine[],
    filter: string,
): LogStreamLine[] => {
    const needle = filter.trim().toLocaleLowerCase();
    if (needle === '') return lines;
    return lines.filter((line) =>
        line.line.toLocaleLowerCase().includes(needle),
    );
};

/** A line's labels as `key=value` pairs, in model order. */
const labelsText = (line: LogStreamLine): string =>
    Object.entries(line.labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');

type RowProps = {
    line: LogStreamLine;
    index: number;
    start: number;
    expanded: boolean;
    showLabels: boolean;
    wrapLines: boolean;
    onToggle: (id: string) => void;
    measureRef: (node: Element | null) => void;
};

const LogStreamRow: FC<RowProps> = ({
    line,
    index,
    start,
    expanded,
    showLabels,
    wrapLines,
    onToggle,
    measureRef,
}) => {
    const toggle = () => onToggle(line.id);
    const inlineLabels = showLabels ? labelsText(line) : null;
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
                className={clsx(classes.header, wrapLines && classes.wrapped)}
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
                {inlineLabels !== null && (
                    <Text
                        data-testid="log-stream-labels"
                        className={classes.inlineLabels}
                        ff="monospace"
                        fz="xs"
                        c="dimmed"
                        title={inlineLabels}
                    >
                        {inlineLabels}
                    </Text>
                )}
                <Text
                    data-testid="log-stream-line"
                    className={clsx(classes.line, wrapLines && classes.wrapped)}
                    ff="monospace"
                    fz="xs"
                    // The wrap mode is per chart, so it rides on the element itself
                    // (the CSS module only adds overflow-wrap for wrapped lines).
                    // oxlint-disable-next-line lightdash-ui/no-inline-style-prop
                    style={{ whiteSpace: wrapLines ? 'pre-wrap' : 'pre' }}
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
 * toggles its details: every label as key and value. With the chart's
 * "show labels" on, each row also shows its labels inline as `key=value`.
 * With "wrap lines" on, long lines wrap and their rows grow to fit (the
 * virtualiser measures them); off, each line stays on one row, cut short.
 * The filter box narrows the loaded lines to those whose text contains it
 * (ignoring case) and the footer counts how many match.
 */
export const LogStreamView: FC<Props> = ({ model, height }) => {
    const total = model.lines.length;
    const [filter, setFilter] = useState('');
    const lines = useMemo(
        () => filterLines(model.lines, filter),
        [model.lines, filter],
    );
    const shown = lines.length;
    const viewportHeight = Math.max(height - TOOLBAR_HEIGHT - FOOTER_HEIGHT, 0);
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
        const line = lines[index];
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
        count: shown,
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
        getItemKey: (index) => lines[index]?.id ?? index,
        initialRect: { width: 0, height: viewportHeight },
        observeElementRect: observeViewport,
        overscan: OVERSCAN,
    });
    const lineCount = `${shown.toLocaleString()} of ${total.toLocaleString()} lines`;

    return (
        <Stack gap={0} h={height} className={classes.root}>
            <Box h={TOOLBAR_HEIGHT} className={classes.toolbar}>
                <TextInput
                    size="xs"
                    w="100%"
                    placeholder="Filter lines"
                    aria-label="Filter lines"
                    value={filter}
                    onChange={(event) => setFilter(event.currentTarget.value)}
                    rightSection={
                        filter !== '' && (
                            <CloseButton
                                size="sm"
                                aria-label="Clear filter"
                                onClick={() => setFilter('')}
                            />
                        )
                    }
                />
            </Box>
            {total === 0 || shown === 0 ? (
                <Center flex={1}>
                    <Text c="dimmed" fz="sm">
                        {total === 0 ? 'No log lines' : 'No lines match'}
                    </Text>
                </Center>
            ) : (
                <ScrollArea flex={1} type="auto" viewportRef={viewportRef}>
                    <Box h={virtualizer.getTotalSize()} pos="relative">
                        {virtualizer.getVirtualItems().map((item) => {
                            const line = lines[item.index];
                            if (!line) return null;
                            return (
                                <LogStreamRow
                                    key={item.key}
                                    line={line}
                                    index={item.index}
                                    start={item.start}
                                    expanded={expandedIds.has(line.id)}
                                    showLabels={model.showLabels}
                                    wrapLines={model.wrapLines}
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
