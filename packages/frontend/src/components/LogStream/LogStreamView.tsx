import {
    type LogStreamLine,
    type LogStreamModel,
} from '@lightdash/visualization';
import { Box, Center, Group, ScrollArea, Stack, Text } from '@mantine/core';
import {
    observeElementRect,
    useVirtualizer,
    type Virtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useRef, type FC } from 'react';
import classes from './LogStreamView.module.css';

type Props = {
    /** The lines to draw, already sorted by `@lightdash/visualization`. */
    model: LogStreamModel;
    /** The view's height in pixels, the count footer included. */
    height: number;
};

const FOOTER_HEIGHT = 28;
/** Every row is one line of text (no wrapping), so rows have a fixed height; keep in step with `.row` in the CSS module. */
const ROW_HEIGHT = 24;
const OVERSCAN = 20;

/** The data's own formatting first, else the ISO time, else nothing. */
const timestampText = (line: LogStreamLine): string => {
    if (line.formattedTimestamp !== '') return line.formattedTimestamp;
    if (line.timestamp === null) return '';
    return new Date(line.timestamp).toISOString();
};

const LogStreamRow: FC<{ line: LogStreamLine; start: number }> = ({
    line,
    start,
}) => (
    <Group
        data-testid="log-stream-row"
        data-level={line.level}
        className={classes.row}
        style={{ '--log-row-start': `${start}px` }}
        gap="sm"
        wrap="nowrap"
        align="flex-start"
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
);

/**
 * A log stream: one row per line, newest or oldest first as the model says.
 * Only the rows in view (plus overscan) are in the page.
 */
export const LogStreamView: FC<Props> = ({ model, height }) => {
    const total = model.lines.length;
    const viewportHeight = Math.max(height - FOOTER_HEIGHT, 0);
    const viewportRef = useRef<HTMLDivElement>(null);
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
        estimateSize: () => ROW_HEIGHT,
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
                                    start={item.start}
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
