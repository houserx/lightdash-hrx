import {
    type AuditExecution,
    type AuditFilters,
    type AuditPage,
} from '@lightdash/common';
import {
    Alert,
    Badge,
    Button,
    Group,
    Loader,
    Stack,
    Table,
    Text,
    TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconLock } from '@tabler/icons-react';
import { useEffect, useRef, useState, type FC, type FormEvent } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';

export type AuditBrowserProps = {
    /** Whether the user holds platform_read; the audit store needs it (CONTRACTS §2, §6). */
    canRead: boolean;
    /** Loads one page of executions. Blank filters are never passed. */
    fetchPage: (query: AuditFilters) => Promise<AuditPage>;
};

type FilterForm = { ticket: string; user: string; month: string };

const EMPTY_FORM: FilterForm = { ticket: '', user: '', month: '' };

/** The query for a filter form: trimmed values, with blank ones left out. */
const toAuditQuery = (form: FilterForm): AuditFilters => {
    const query: AuditFilters = {};
    (Object.keys(form) as (keyof FilterForm)[]).forEach((key) => {
        const value = form[key].trim();
        if (value) query[key] = value;
    });
    return query;
};

const formatTime = (iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

const errorMessage = (error: unknown) => {
    if (error && typeof error === 'object') {
        const nested = (error as { error?: { message?: unknown } }).error;
        if (typeof nested?.message === 'string') return nested.message;
        const { message } = error as { message?: unknown };
        if (typeof message === 'string' && message) return message;
    }
    return 'The audit records could not be loaded';
};

const ExecutionRow: FC<{ execution: AuditExecution }> = ({ execution }) => (
    <Table.Tr>
        <Table.Td miw={140}>{formatTime(execution.createdAt)}</Table.Td>
        <Table.Td>{execution.executedByEmail}</Table.Td>
        <Table.Td>{execution.description || '—'}</Table.Td>
        <Table.Td>{execution.linearTicketId || '—'}</Table.Td>
        <Table.Td>
            <Group gap={4} wrap="nowrap">
                <Badge
                    variant="light"
                    color={execution.mode === 'write' ? 'red' : 'gray'}
                >
                    {execution.mode}
                </Badge>
                {execution.preview && (
                    <Badge variant="outline" color="gray">
                        preview
                    </Badge>
                )}
            </Group>
        </Table.Td>
        <Table.Td>{execution.status}</Table.Td>
        <Table.Td>{execution.rowCount ?? '—'}</Table.Td>
    </Table.Tr>
);

/**
 * Audit browser over the Federation Engine's audit store (ADR 0004, CONTRACTS §6): lists
 * Audited Query and Write Mode executions, filtered by ticket, user and month.
 */
export const AuditBrowser: FC<AuditBrowserProps> = ({ canRead, fetchPage }) => {
    const [form, setForm] = useState<FilterForm>(EMPTY_FORM);
    const [query, setQuery] = useState<AuditFilters>({});
    const [page, setPage] = useState<AuditPage | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const fetchPageRef = useRef(fetchPage);
    fetchPageRef.current = fetchPage;

    useEffect(() => {
        if (!canRead) return undefined;
        let current = true;
        setLoading(true);
        setError(null);
        fetchPageRef
            .current(query)
            .then((result) => {
                if (current) setPage(result);
            })
            .catch((reason: unknown) => {
                if (!current) return;
                setPage(null);
                setError(errorMessage(reason));
            })
            .finally(() => {
                if (current) setLoading(false);
            });
        return () => {
            current = false;
        };
    }, [canRead, query]);

    if (!canRead) {
        return (
            <Alert
                color="gray"
                icon={<MantineIcon icon={IconLock} />}
                title="You can't view the audit browser"
            >
                Browsing audit records needs the platform_read attribute on this
                project. Ask an admin to grant it.
            </Alert>
        );
    }

    const setField = (key: keyof FilterForm) => (value: string) =>
        setForm((previous) => ({ ...previous, [key]: value }));

    const applyFilters = (event: FormEvent) => {
        event.preventDefault();
        setQuery(toAuditQuery(form));
    };

    const items = page?.items ?? [];

    return (
        <Stack gap="md">
            <form onSubmit={applyFilters}>
                <Group align="flex-end" gap="sm">
                    <TextInput
                        label="Ticket"
                        placeholder="ENG-123"
                        value={form.ticket}
                        onChange={(event) =>
                            setField('ticket')(event.currentTarget.value)
                        }
                    />
                    <TextInput
                        label="User"
                        placeholder="name@example.com"
                        value={form.user}
                        onChange={(event) =>
                            setField('user')(event.currentTarget.value)
                        }
                    />
                    <TextInput
                        label="Month"
                        placeholder="YYYY-MM"
                        value={form.month}
                        onChange={(event) =>
                            setField('month')(event.currentTarget.value)
                        }
                    />
                    <Button type="submit" loading={loading}>
                        Apply filters
                    </Button>
                </Group>
            </form>
            {error && (
                <Alert
                    color="red"
                    icon={<MantineIcon icon={IconAlertCircle} />}
                    title="Audit records unavailable"
                >
                    {error}
                </Alert>
            )}
            {loading && !page ? (
                <Loader size="sm" />
            ) : (
                !error && (
                    <Table
                        striped
                        withTableBorder
                        data-testid="audit-executions"
                    >
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Time</Table.Th>
                                <Table.Th>User</Table.Th>
                                <Table.Th>Description</Table.Th>
                                <Table.Th>Ticket</Table.Th>
                                <Table.Th>Mode</Table.Th>
                                <Table.Th>Status</Table.Th>
                                <Table.Th>Rows</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {items.map((execution) => (
                                <ExecutionRow
                                    key={execution.id}
                                    execution={execution}
                                />
                            ))}
                        </Table.Tbody>
                    </Table>
                )
            )}
            {!loading && !error && page && items.length === 0 && (
                <Text c="dimmed" size="sm">
                    No executions match these filters.
                </Text>
            )}
        </Stack>
    );
};
