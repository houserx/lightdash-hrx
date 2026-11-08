import {
    type LogStreamLine,
    type LogStreamModel,
} from '@lightdash/visualization';
import { Box, Center, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { type FC } from 'react';
import classes from './LogStreamView.module.css';

type Props = {
    /** The lines to draw, already sorted by `@lightdash/visualization`. */
    model: LogStreamModel;
    /** The view's height in pixels, the count footer included. */
    height: number;
};

const FOOTER_HEIGHT = 28;

/** The data's own formatting first, else the ISO time, else nothing. */
const timestampText = (line: LogStreamLine): string => {
    if (line.formattedTimestamp !== '') return line.formattedTimestamp;
    if (line.timestamp === null) return '';
    return new Date(line.timestamp).toISOString();
};

const LogStreamRow: FC<{ line: LogStreamLine }> = ({ line }) => (
    <Group
        data-testid="log-stream-row"
        data-level={line.level}
        className={classes.row}
        gap="sm"
        wrap="nowrap"
        align="flex-start"
    >
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

/** A log stream: one row per line, newest or oldest first as the model says. */
export const LogStreamView: FC<Props> = ({ model, height }) => {
    const total = model.lines.length;
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
                <ScrollArea flex={1} type="auto">
                    {model.lines.map((line) => (
                        <LogStreamRow key={line.id} line={line} />
                    ))}
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
