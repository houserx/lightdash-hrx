// The Contact Points list (ENG-1799): one row per Contact Point with its
// integrations, a 'Managed in git' badge, and "Send test notification",
// which shows "Test notification sent" or the failing integrations' errors.
// Presentational: the Contact Points come in as props; sending the test and
// opening a Contact Point are callbacks.
import {
    type ContactPoint,
    type ContactPointIntegrationType,
    type ContactPointTestResult,
} from '@lightdash/common';
import {
    Anchor,
    Button,
    Group,
    Stack,
    Table,
    Text,
    ThemeIcon,
    Tooltip,
} from '@mantine/core';
import {
    IconBrandSlack,
    IconMail,
    IconUrgent,
    IconWebhook,
    type Icon,
} from '@tabler/icons-react';
import { useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import {
    CONTACT_POINT_INTEGRATION_LABELS,
    describeContactPointTestFailure,
} from '../utils';
import { ManagedInGitBadge } from './AlertBadges';
import classes from './ContactPointsList.module.css';

type Props = {
    contactPoints: ContactPoint[];
    /** Sends a synthetic TestAlert through every integration. */
    onSendTest: (contactPointUuid: string) => Promise<ContactPointTestResult>;
    onOpen: (contactPointUuid: string) => void;
};

type TestState =
    | { status: 'sending' }
    | { status: 'sent' }
    | { status: 'failed'; error: string };

const INTEGRATION_ICONS: Record<ContactPointIntegrationType, Icon> = {
    slack_webhook: IconBrandSlack,
    slack_app: IconBrandSlack,
    incident_io: IconUrgent,
    email: IconMail,
    webhook: IconWebhook,
};

// The integration type is an icon with its name as the accessible label
// and tooltip, so a row's visible text is its name alone.
const IntegrationIcon: FC<{ type: ContactPointIntegrationType }> = ({
    type,
}) => {
    const label = CONTACT_POINT_INTEGRATION_LABELS[type] ?? type;
    return (
        <Tooltip label={label} withinPortal>
            <ThemeIcon
                variant="light"
                color="gray"
                size="md"
                role="img"
                aria-label={label}
            >
                <MantineIcon icon={INTEGRATION_ICONS[type] ?? IconWebhook} />
            </ThemeIcon>
        </Tooltip>
    );
};

const errorMessage = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    const apiMessage = (e as { error?: { message?: unknown } } | null)?.error
        ?.message;
    return typeof apiMessage === 'string'
        ? apiMessage
        : 'The test notification could not be sent';
};

export const ContactPointsList: FC<Props> = ({
    contactPoints,
    onSendTest,
    onOpen,
}) => {
    const [tests, setTests] = useState<Record<string, TestState>>({});

    const sendTest = async (uuid: string) => {
        setTests((prev) => ({ ...prev, [uuid]: { status: 'sending' } }));
        let next: TestState;
        try {
            const failure = describeContactPointTestFailure(
                await onSendTest(uuid),
            );
            next =
                failure === null
                    ? { status: 'sent' }
                    : { status: 'failed', error: failure };
        } catch (e) {
            next = { status: 'failed', error: errorMessage(e) };
        }
        setTests((prev) => ({ ...prev, [uuid]: next }));
    };

    return (
        <Stack gap="md">
            <Table highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Integrations</Table.Th>
                        <Table.Th>Test</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {contactPoints.map((contactPoint) => {
                        const test = tests[contactPoint.uuid];
                        return (
                            <Table.Tr
                                key={contactPoint.uuid}
                                className={classes.row}
                                onClick={() => onOpen(contactPoint.uuid)}
                            >
                                <Table.Td>
                                    <Group gap="xs" wrap="nowrap">
                                        <Anchor component="button" fw={500}>
                                            {contactPoint.name}
                                        </Anchor>
                                        {contactPoint.managed && (
                                            <ManagedInGitBadge />
                                        )}
                                    </Group>
                                </Table.Td>
                                <Table.Td>
                                    <Group gap={4}>
                                        {contactPoint.integrations.map(
                                            (integration, i) => (
                                                <IntegrationIcon
                                                    key={i}
                                                    type={integration.type}
                                                />
                                            ),
                                        )}
                                    </Group>
                                </Table.Td>
                                <Table.Td
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    <Stack gap={4} align="flex-start">
                                        <Button
                                            size="xs"
                                            variant="default"
                                            loading={test?.status === 'sending'}
                                            onClick={() =>
                                                void sendTest(contactPoint.uuid)
                                            }
                                        >
                                            Send test notification
                                        </Button>
                                        {test?.status === 'sent' && (
                                            <Text size="xs" c="green">
                                                Test notification sent
                                            </Text>
                                        )}
                                        {test?.status === 'failed' && (
                                            <Text size="xs" c="red">
                                                {test.error}
                                            </Text>
                                        )}
                                    </Stack>
                                </Table.Td>
                            </Table.Tr>
                        );
                    })}
                </Table.Tbody>
            </Table>
            {contactPoints.length === 0 && (
                <Text c="dimmed" size="sm" ta="center">
                    No Contact Points yet.
                </Text>
            )}
        </Stack>
    );
};
