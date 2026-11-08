import {
    Alert,
    Group,
    Loader,
    ScrollArea,
    Stack,
    Text,
    TextInput,
    UnstyledButton,
} from '@mantine/core';
import {
    IconAlertCircle,
    IconChevronDown,
    IconChevronRight,
    IconSearch,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';

/** One row of platform_tables() (CONTRACTS §1.1). */
export type PlatformTable = {
    table_schema: string;
    table_name: string;
};

/** One row of platform_columns(table_schema, table_name) (CONTRACTS §1.1). */
export type PlatformColumn = {
    column_name: string;
    data_type: string;
    is_nullable: boolean;
};

/** How the browser reads the Platform Database catalog. */
export type PlatformSchemaLoaders = {
    loadTables: () => Promise<PlatformTable[]>;
    loadColumns: (
        tableSchema: string,
        tableName: string,
    ) => Promise<PlatformColumn[]>;
};

type Props = PlatformSchemaLoaders & {
    /** Called with a column's name when the user clicks it. */
    onInsert: (text: string) => void;
};

type LoadState<T> =
    | { status: 'loading' }
    | { status: 'done'; data: T }
    | { status: 'failed'; error: string };

const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback;

const tableKey = (table: PlatformTable) =>
    JSON.stringify([table.table_schema, table.table_name]);

/**
 * Lists the Platform Database tables grouped by schema, with a search over table names.
 * Clicking a table loads its columns once and shows them with their types; clicking a column
 * hands its name to onInsert. Tables load when the browser mounts, columns only on demand,
 * because every catalog read is an Audited Query.
 */
export const PlatformSchemaBrowser: FC<Props> = ({
    loadTables,
    loadColumns,
    onInsert,
}) => {
    const [tables, setTables] = useState<LoadState<PlatformTable[]>>({
        status: 'loading',
    });
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [columns, setColumns] = useState<
        Record<string, LoadState<PlatformColumn[]>>
    >({});

    // Load the table list once per mount, whatever the parent's callback identity.
    const loadTablesRef = useRef(loadTables);
    loadTablesRef.current = loadTables;
    useEffect(() => {
        let cancelled = false;
        loadTablesRef
            .current()
            .then((data) => {
                if (!cancelled) setTables({ status: 'done', data });
            })
            .catch((error: unknown) => {
                if (!cancelled)
                    setTables({
                        status: 'failed',
                        error: errorMessage(
                            error,
                            'Could not load the Platform Database tables',
                        ),
                    });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const schemas = useMemo(() => {
        if (tables.status !== 'done') return [];
        const needle = search.trim().toLowerCase();
        const bySchema = new Map<string, PlatformTable[]>();
        tables.data
            .filter(
                (table) =>
                    needle === '' ||
                    table.table_name.toLowerCase().includes(needle),
            )
            .forEach((table) => {
                const list = bySchema.get(table.table_schema) ?? [];
                list.push(table);
                bySchema.set(table.table_schema, list);
            });
        return Array.from(bySchema.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([schema, list]) => ({
                schema,
                tables: [...list].sort((a, b) =>
                    a.table_name.localeCompare(b.table_name),
                ),
            }));
    }, [tables, search]);

    const fetchColumns = async (table: PlatformTable) => {
        const key = tableKey(table);
        setColumns((current) => ({ ...current, [key]: { status: 'loading' } }));
        try {
            const data = await loadColumns(
                table.table_schema,
                table.table_name,
            );
            setColumns((current) => ({
                ...current,
                [key]: { status: 'done', data },
            }));
        } catch (error) {
            setColumns((current) => ({
                ...current,
                [key]: {
                    status: 'failed',
                    error: errorMessage(error, 'Could not load the columns'),
                },
            }));
        }
    };

    const toggleTable = (table: PlatformTable) => {
        const key = tableKey(table);
        const isOpen = expanded.has(key);
        setExpanded((current) => {
            const next = new Set(current);
            if (isOpen) next.delete(key);
            else next.add(key);
            return next;
        });
        // Columns load once; a failed load is retried when the table is opened again.
        const loaded = columns[key];
        if (!isOpen && (loaded === undefined || loaded.status === 'failed')) {
            void fetchColumns(table);
        }
    };

    return (
        <Stack gap="xs" data-testid="platform-schema-browser">
            <TextInput
                label="Search tables"
                size="xs"
                leftSection={<MantineIcon icon={IconSearch} />}
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
            />
            {tables.status === 'loading' && <Loader size="sm" />}
            {tables.status === 'failed' && (
                <Alert
                    color="red"
                    icon={<MantineIcon icon={IconAlertCircle} />}
                    title="Could not load tables"
                >
                    {tables.error}
                </Alert>
            )}
            {tables.status === 'done' && schemas.length === 0 && (
                <Text size="xs" c="dimmed">
                    {search.trim() === ''
                        ? 'No tables are visible.'
                        : 'No tables match your search.'}
                </Text>
            )}
            {schemas.length > 0 && (
                <ScrollArea.Autosize mah={360}>
                    <Stack gap="xs">
                        {schemas.map(({ schema, tables: schemaTables }) => (
                            <Stack key={schema} gap={2}>
                                <Text size="xs" fw={600} c="dimmed">
                                    {schema}
                                </Text>
                                {schemaTables.map((table) => {
                                    const key = tableKey(table);
                                    const isOpen = expanded.has(key);
                                    return (
                                        <Stack key={key} gap={2}>
                                            <UnstyledButton
                                                aria-expanded={isOpen}
                                                onClick={() =>
                                                    toggleTable(table)
                                                }
                                            >
                                                <Group gap={4} wrap="nowrap">
                                                    <MantineIcon
                                                        icon={
                                                            isOpen
                                                                ? IconChevronDown
                                                                : IconChevronRight
                                                        }
                                                    />
                                                    <Text size="sm">
                                                        {table.table_name}
                                                    </Text>
                                                </Group>
                                            </UnstyledButton>
                                            {isOpen && (
                                                <TableColumns
                                                    state={columns[key]}
                                                    onInsert={onInsert}
                                                />
                                            )}
                                        </Stack>
                                    );
                                })}
                            </Stack>
                        ))}
                    </Stack>
                </ScrollArea.Autosize>
            )}
        </Stack>
    );
};

const TableColumns: FC<{
    state: LoadState<PlatformColumn[]> | undefined;
    onInsert: (text: string) => void;
}> = ({ state, onInsert }) => {
    if (state === undefined || state.status === 'loading') {
        return <Loader size="xs" ml="lg" />;
    }
    if (state.status === 'failed') {
        return (
            <Text size="xs" c="red" ml="lg">
                {state.error}
            </Text>
        );
    }
    if (state.data.length === 0) {
        return (
            <Text size="xs" c="dimmed" ml="lg">
                No columns
            </Text>
        );
    }
    return (
        <Stack gap={0} ml="lg">
            {state.data.map((column) => (
                <UnstyledButton
                    key={column.column_name}
                    title={`Insert ${column.column_name}`}
                    onClick={() => onInsert(column.column_name)}
                >
                    <Group gap="xs" wrap="nowrap" justify="space-between">
                        <Text size="xs" ff="monospace">
                            {column.column_name}
                        </Text>
                        <Group gap={4} wrap="nowrap">
                            <Text size="xs" c="dimmed">
                                {column.data_type}
                            </Text>
                            {column.is_nullable === false && (
                                <Text size="xs" c="dimmed">
                                    not null
                                </Text>
                            )}
                        </Group>
                    </Group>
                </UnstyledButton>
            ))}
        </Stack>
    );
};
