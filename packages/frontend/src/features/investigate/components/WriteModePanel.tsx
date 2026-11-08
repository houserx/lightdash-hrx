import {
    type ApiWriteRequest,
    type WriteConfirmation,
    type WriteResult,
} from '@lightdash/common';
import {
    Alert,
    Badge,
    Button,
    Code,
    Group,
    Paper,
    Stack,
    Table,
    Text,
    TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconEye } from '@tabler/icons-react';
import { useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';

/**
 * How Write Mode reaches Lightdash (CONTRACTS §4.2): a fresh single-statement confirmation
 * token for each Preview or Commit, then the write itself with that token.
 */
export type WriteModeApi = {
    createConfirmation: (statement: string) => Promise<WriteConfirmation>;
    write: (request: ApiWriteRequest) => Promise<WriteResult>;
};

export type WriteModePanelProps = {
    /** The Platform Database statement exactly as written in the Platform SQL box. */
    statement: string;
    api: WriteModeApi;
};

type WriteState =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; statement: string; result: WriteResult }
    | { status: 'failed'; statement: string; error: string };

/**
 * The message of a thrown Error, or of a Lightdash API error body ({ error: { message } }),
 * which is how the engine's refusals reach the browser.
 */
const errorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'object' && error !== null && 'error' in error) {
        const { error: detail } = error as { error?: { message?: unknown } };
        if (typeof detail?.message === 'string' && detail.message) {
            return detail.message;
        }
    }
    return fallback;
};

const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const ReturnedRows: FC<{ rows: Record<string, unknown>[] }> = ({ rows }) => {
    if (rows.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No rows returned.
            </Text>
        );
    }
    const columns = Array.from(
        new Set(rows.flatMap((row) => Object.keys(row))),
    );
    return (
        <Table striped withTableBorder data-testid="write-mode-returning">
            <Table.Thead>
                <Table.Tr>
                    {columns.map((column) => (
                        <Table.Th key={column}>{column}</Table.Th>
                    ))}
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
                {rows.map((row, index) => (
                    <Table.Tr key={index}>
                        {columns.map((column) => (
                            <Table.Td key={column}>
                                {formatCell(row[column])}
                            </Table.Td>
                        ))}
                    </Table.Tr>
                ))}
            </Table.Tbody>
        </Table>
    );
};

const WriteResultView: FC<{ result: WriteResult }> = ({ result }) => (
    <Stack gap="xs" data-testid="write-mode-result">
        <Group gap="xs">
            <Badge color={result.preview ? 'yellow' : 'green'} variant="light">
                {result.preview ? 'Rolled back' : 'Committed'}
            </Badge>
            <Text size="sm">Rows affected: {result.rows_affected}</Text>
        </Group>
        {result.preview && (
            <Text size="xs" c="dimmed">
                Preview ran the statement in a transaction that was rolled back;
                nothing was changed.
            </Text>
        )}
        {result.returning && <ReturnedRows rows={result.returning} />}
    </Stack>
);

/**
 * Write Mode for one Platform Database statement. Preview needs a Description (a Linear ticket
 * is optional); it fetches a fresh confirmation token for the statement, runs it in a
 * transaction the engine always rolls back, and shows the rows affected and returned rows.
 * Engine refusals are shown as they were sent.
 */
export const WriteModePanel: FC<WriteModePanelProps> = ({ statement, api }) => {
    const [description, setDescription] = useState('');
    const [ticket, setTicket] = useState('');
    const [state, setState] = useState<WriteState>({ status: 'idle' });

    const trimmedDescription = description.trim();
    const trimmedTicket = ticket.trim();
    const isRunning = state.status === 'running';
    // A result describes the statement it ran; editing the statement hides it.
    const shown =
        (state.status === 'done' || state.status === 'failed') &&
        state.statement === statement
            ? state
            : undefined;
    const canPreview =
        statement.trim() !== '' && trimmedDescription !== '' && !isRunning;

    const handlePreview = async () => {
        setState({ status: 'running' });
        try {
            const { confirmationToken } =
                await api.createConfirmation(statement);
            const result = await api.write({
                statement,
                mode: 'preview',
                confirmationToken,
                description: trimmedDescription,
                ...(trimmedTicket && { ticket: trimmedTicket }),
            });
            setState({ status: 'done', statement, result });
        } catch (error) {
            setState({
                status: 'failed',
                statement,
                error: errorMessage(error, 'The preview failed'),
            });
        }
    };

    return (
        <Paper withBorder p="sm" data-testid="write-mode-panel">
            <Stack gap="xs">
                <Text size="sm" fw={600}>
                    Write Mode
                </Text>
                {statement.trim() === '' ? (
                    <Text size="sm" c="dimmed">
                        Write a statement in the Platform SQL box.
                    </Text>
                ) : (
                    <Code block>{statement}</Code>
                )}
                <Group align="flex-start" grow>
                    <TextInput
                        label="Description"
                        description="Why you are making this change; it is recorded in the audit log."
                        required
                        value={description}
                        onChange={(event) =>
                            setDescription(event.currentTarget.value)
                        }
                    />
                    <TextInput
                        label="Linear ticket"
                        description="Optional, e.g. ENG-123."
                        placeholder="ENG-123"
                        value={ticket}
                        onChange={(event) =>
                            setTicket(event.currentTarget.value)
                        }
                    />
                </Group>
                <Group justify="flex-end">
                    <Button
                        size="xs"
                        variant="default"
                        leftSection={<MantineIcon icon={IconEye} />}
                        disabled={!canPreview}
                        loading={isRunning}
                        onClick={handlePreview}
                    >
                        Preview
                    </Button>
                </Group>
                {shown?.status === 'failed' && (
                    <Alert
                        color="red"
                        icon={<MantineIcon icon={IconAlertCircle} />}
                        title="Write refused"
                    >
                        {shown.error}
                    </Alert>
                )}
                {shown?.status === 'done' && (
                    <WriteResultView result={shown.result} />
                )}
            </Stack>
        </Paper>
    );
};
