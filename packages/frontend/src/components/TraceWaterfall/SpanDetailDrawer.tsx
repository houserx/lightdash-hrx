import { type TraceWaterfallSpan } from '@lightdash/visualization';
import { Alert, Code, Drawer, Group, Stack, Table, Text } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { type FC, type ReactNode } from 'react';
import MantineIcon from '../common/MantineIcon';
import { formatDurationMs, isErrorStatus } from './traceWaterfallFormat';
import classes from './TraceWaterfallView.module.css';

type Props = {
    /** The span to show; the drawer is closed while it is null. */
    span: TraceWaterfallSpan | null;
    onClose: () => void;
};

/** An attribute value as text: strings as they are, anything else as JSON. */
const attributeText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
};

const DetailRow: FC<{ label: string; children: ReactNode }> = ({
    label,
    children,
}) => (
    <Group gap="xs" wrap="nowrap" align="baseline">
        <Text fz="xs" c="dimmed" fw={500} className={classes.detailLabel}>
            {label}
        </Text>
        {children}
    </Group>
);

const SpanDetails: FC<{ span: TraceWaterfallSpan }> = ({ span }) => {
    const attributes = Object.entries(span.attributes);
    return (
        <Stack gap="md" data-testid="trace-span-drawer">
            {span.isClamped && (
                <Alert
                    color="yellow"
                    variant="light"
                    icon={<MantineIcon icon={IconClock} />}
                >
                    <Text fz="xs">
                        Drawn inside its parent&apos;s window: the span was
                        clamped because of clock skew.
                    </Text>
                </Alert>
            )}
            {span.isOrphan && (
                <Alert color="gray" variant="light">
                    <Text fz="xs">
                        Its parent span is not in the results, so it is drawn as
                        a root.
                    </Text>
                </Alert>
            )}
            <Stack gap={6}>
                <DetailRow label="Service">
                    <Text fz="sm">{span.service || '(no service)'}</Text>
                </DetailRow>
                <DetailRow label="Status">
                    <Text
                        fz="sm"
                        c={isErrorStatus(span.status) ? 'red' : undefined}
                    >
                        {span.status}
                    </Text>
                </DetailRow>
                <DetailRow label="Duration">
                    <Text fz="sm">
                        {formatDurationMs(span.reportedDurationMs)}
                    </Text>
                </DetailRow>
                {span.isClamped && (
                    <DetailRow label="Drawn duration">
                        <Text fz="sm">{formatDurationMs(span.durationMs)}</Text>
                    </DetailRow>
                )}
                <DetailRow label="Start offset">
                    <Text fz="sm">{formatDurationMs(span.offsetMs)}</Text>
                </DetailRow>
                <DetailRow label="Span id">
                    <Code>{span.spanId}</Code>
                </DetailRow>
                {span.parentSpanId !== null && (
                    <DetailRow label="Parent span id">
                        <Code>{span.parentSpanId}</Code>
                    </DetailRow>
                )}
                <DetailRow label="Trace id">
                    <Code>{span.traceId}</Code>
                </DetailRow>
            </Stack>
            <Stack gap={4}>
                <Text fz="xs" c="dimmed" fw={500}>
                    Attributes
                </Text>
                {attributes.length === 0 ? (
                    <Text fz="sm" c="dimmed">
                        No attributes
                    </Text>
                ) : (
                    <Table
                        data-testid="trace-span-attributes"
                        withTableBorder
                        withColumnBorders
                        fz="xs"
                    >
                        <Table.Tbody>
                            {attributes.map(([key, value]) => (
                                <Table.Tr key={key}>
                                    <Table.Td fw={500}>{key}</Table.Td>
                                    <Table.Td
                                        className={classes.attributeValue}
                                    >
                                        {attributeText(value)}
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Stack>
        </Stack>
    );
};

/**
 * The details of one waterfall span: its name, service, status, reported
 * duration, ids and every attribute, with a note when the span was clamped
 * into its parent's window for clock skew or drawn as an orphan root.
 */
export const SpanDetailDrawer: FC<Props> = ({ span, onClose }) => (
    <Drawer
        opened={span !== null}
        onClose={onClose}
        position="right"
        size="md"
        title={
            span && (
                <Text fw={600} fz="sm">
                    {span.name}
                </Text>
            )
        }
    >
        {span && <SpanDetails span={span} />}
    </Drawer>
);
