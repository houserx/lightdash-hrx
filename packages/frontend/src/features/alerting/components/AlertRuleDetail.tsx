// The Alert Rule page (ENG-1799): the rule's definition and query, its
// current series, the state history timeline (transitions and skipped
// evaluations) and the notifications sent for it.
// Presentational: the rule, history and notifications come in as props.
import {
    type AlertNotification,
    type AlertRuleWithInstances,
    type AlertStateHistoryEntry,
} from '@lightdash/common';
import {
    Badge,
    Code,
    Group,
    Paper,
    Stack,
    Table,
    Text,
    Timeline,
    Title,
    type MantineColor,
} from '@mantine/core';
import dayjs from 'dayjs';
import { useMemo, type FC, type ReactNode } from 'react';
import {
    describeHistoryEntry,
    formatAlertCondition,
    formatLabels,
} from '../utils';
import { AlertStateBadge, ManagedInGitBadge } from './AlertBadges';

/**
 * A notification log entry as the page shows it. The notification API has
 * no Contact Point name, so the page may join one in (`contactPointName`);
 * otherwise it is looked up in `contactPoints`.
 */
export type AlertRuleNotification = AlertNotification & {
    contactPointName?: string | null;
};

type Props = {
    rule: AlertRuleWithInstances;
    /** The rule's state history, newest first. */
    history: AlertStateHistoryEntry[];
    /** The rule's notification log, newest first. */
    notifications: AlertRuleNotification[];
    /** Contact Points of the project, to name notifications by. */
    contactPoints?: { uuid: string; name: string }[];
};

const NOTIFICATION_STATUS: Record<
    AlertNotification['status'],
    { label: string; color: MantineColor }
> = {
    sent: { label: 'Sent', color: 'green' },
    failed: { label: 'Failed', color: 'red' },
    shadow: { label: 'Shadow', color: 'indigo' },
};

const formatTime = (iso: string | null | undefined) =>
    iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : '—';

const formatValue = (value: number | null) =>
    value === null ? '—' : String(value);

const LabelBadges: FC<{ labels: Record<string, string> }> = ({ labels }) => (
    <Group gap={4}>
        {formatLabels(labels).map((label) => (
            <Badge
                key={label}
                color="gray"
                variant="outline"
                radius="sm"
                tt="none"
            >
                {label}
            </Badge>
        ))}
    </Group>
);

const Section: FC<{ title: string; children: ReactNode }> = ({
    title,
    children,
}) => (
    <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
            <Title order={4}>{title}</Title>
            {children}
        </Stack>
    </Paper>
);

const Empty: FC<{ children: ReactNode }> = ({ children }) => (
    <Text c="dimmed" size="sm">
        {children}
    </Text>
);

export const AlertRuleDetail: FC<Props> = ({
    rule,
    history,
    notifications,
    contactPoints,
}) => {
    const contactPointNames = useMemo(
        () => new Map((contactPoints ?? []).map((cp) => [cp.uuid, cp.name])),
        [contactPoints],
    );

    const contactPointName = (entry: AlertRuleNotification) =>
        entry.contactPointName ??
        (entry.contactPointUuid
            ? contactPointNames.get(entry.contactPointUuid)
            : undefined) ??
        entry.contactPointUuid ??
        'Deleted Contact Point';

    return (
        <Stack gap="md">
            <Stack gap="xs">
                <Group gap="sm">
                    <Title order={2}>{rule.name}</Title>
                    <AlertStateBadge state={rule.state} />
                    {rule.managed && <ManagedInGitBadge />}
                    {rule.paused && (
                        <Badge color="gray" variant="light" radius="sm">
                            Paused
                        </Badge>
                    )}
                    {rule.shadow && (
                        <Badge color="indigo" variant="light" radius="sm">
                            Shadow
                        </Badge>
                    )}
                </Group>
                {rule.description && <Text c="dimmed">{rule.description}</Text>}
                <LabelBadges labels={rule.labels} />
            </Stack>

            <Section title="Query">
                <Code block>{rule.query}</Code>
                <Group gap="xl">
                    <Text size="sm">
                        Condition:{' '}
                        <Code>
                            {formatAlertCondition(
                                rule.reducer,
                                rule.valueColumn,
                                rule.condition,
                            )}
                        </Code>
                    </Text>
                    <Text size="sm">Every {rule.interval}</Text>
                    <Text size="sm">For {rule.for}</Text>
                    <Text size="sm">Time range {rule.timeRange}</Text>
                </Group>
            </Section>

            <Section title="Series">
                {rule.instances.length === 0 ? (
                    <Empty>No series yet.</Empty>
                ) : (
                    <Table verticalSpacing="xs">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>State</Table.Th>
                                <Table.Th>Labels</Table.Th>
                                <Table.Th>Value</Table.Th>
                                <Table.Th>Since</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {rule.instances.map((instance) => (
                                <Table.Tr key={instance.fingerprint}>
                                    <Table.Td>
                                        <AlertStateBadge
                                            state={instance.state}
                                        />
                                    </Table.Td>
                                    <Table.Td>
                                        <LabelBadges labels={instance.labels} />
                                    </Table.Td>
                                    <Table.Td>
                                        {formatValue(instance.value)}
                                    </Table.Td>
                                    <Table.Td>
                                        {formatTime(instance.since)}
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                )}
            </Section>

            <Section title="State history">
                {history.length === 0 ? (
                    <Empty>No state changes yet.</Empty>
                ) : (
                    <Timeline bulletSize={14} lineWidth={2}>
                        {history.map((entry, index) => (
                            <Timeline.Item
                                key={`${entry.type}-${entry.at}-${index}`}
                                color={
                                    entry.type === 'transition'
                                        ? undefined
                                        : 'gray'
                                }
                                title={describeHistoryEntry(entry)}
                            >
                                <Text size="xs" c="dimmed">
                                    {formatTime(entry.at)}
                                </Text>
                                {entry.type === 'transition' && (
                                    <Group gap="xs" mt={4}>
                                        <LabelBadges labels={entry.labels} />
                                        <Text size="xs">
                                            Value {formatValue(entry.value)}
                                        </Text>
                                    </Group>
                                )}
                            </Timeline.Item>
                        ))}
                    </Timeline>
                )}
            </Section>

            <Section title="Notifications">
                {notifications.length === 0 ? (
                    <Empty>No notifications yet.</Empty>
                ) : (
                    <Table verticalSpacing="xs">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Time</Table.Th>
                                <Table.Th>Contact Point</Table.Th>
                                <Table.Th>Alert</Table.Th>
                                <Table.Th>Status</Table.Th>
                                <Table.Th>Attempts</Table.Th>
                                <Table.Th>Error</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {notifications.map((entry) => {
                                const status = NOTIFICATION_STATUS[
                                    entry.status
                                ] ?? { label: entry.status, color: 'gray' };
                                return (
                                    <Table.Tr key={entry.uuid}>
                                        <Table.Td>
                                            {formatTime(
                                                entry.sentAt ?? entry.createdAt,
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm" fw={500}>
                                                {contactPointName(entry)}
                                            </Text>
                                            {entry.integrationType && (
                                                <Text size="xs" c="dimmed">
                                                    {entry.integrationType}
                                                </Text>
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {entry.alertStatus === 'firing'
                                                ? 'Firing'
                                                : 'Resolved'}
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge
                                                color={status.color}
                                                variant="light"
                                                radius="sm"
                                            >
                                                {status.label}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>{entry.attempts}</Table.Td>
                                        <Table.Td>
                                            {entry.error && (
                                                <Text size="sm" c="red">
                                                    {entry.error}
                                                </Text>
                                            )}
                                        </Table.Td>
                                    </Table.Tr>
                                );
                            })}
                        </Table.Tbody>
                    </Table>
                )}
            </Section>
        </Stack>
    );
};
