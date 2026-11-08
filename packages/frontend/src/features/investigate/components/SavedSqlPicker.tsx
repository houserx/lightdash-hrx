import {
    Group,
    ScrollArea,
    Stack,
    Text,
    TextInput,
    UnstyledButton,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useMemo, useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';

/** One shared saved SQL (a SQL chart) in a space of the Operations Project. */
export type SavedSqlItem = {
    uuid: string;
    name: string;
    description: string | null;
    spaceName: string;
};

type Props<T extends SavedSqlItem> = {
    items: T[];
    /** Called with the clicked item, exactly as it was passed in. */
    onSelect: (item: T) => void;
};

const matches = (item: SavedSqlItem, needle: string) =>
    [item.name, item.description ?? '', item.spaceName].some((text) =>
        text.toLowerCase().includes(needle),
    );

/**
 * Lists shared saved SQL with its name, description and space, with a search over those
 * three. Clicking one hands it to onSelect, which opens its SQL.
 */
export const SavedSqlPicker = <T extends SavedSqlItem>({
    items,
    onSelect,
}: Props<T>): ReturnType<FC> => {
    const [search, setSearch] = useState('');

    const visible = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return needle === ''
            ? items
            : items.filter((item) => matches(item, needle));
    }, [items, search]);

    if (items.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No saved SQL yet
            </Text>
        );
    }

    return (
        <Stack gap="xs" data-testid="saved-sql-picker">
            <TextInput
                label="Search saved SQL"
                size="xs"
                leftSection={<MantineIcon icon={IconSearch} />}
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
            />
            {visible.length === 0 ? (
                <Text size="xs" c="dimmed">
                    No saved SQL matches your search.
                </Text>
            ) : (
                <ScrollArea.Autosize mah={420}>
                    <Stack gap={4}>
                        {visible.map((item) => (
                            <UnstyledButton
                                key={item.uuid}
                                p="xs"
                                onClick={() => onSelect(item)}
                            >
                                <Group
                                    justify="space-between"
                                    align="flex-start"
                                    wrap="nowrap"
                                >
                                    <Stack gap={2}>
                                        <Text size="sm" fw={500}>
                                            {item.name}
                                        </Text>
                                        {item.description && (
                                            <Text size="xs" c="dimmed">
                                                {item.description}
                                            </Text>
                                        )}
                                    </Stack>
                                    <Text size="xs" c="dimmed">
                                        {item.spaceName}
                                    </Text>
                                </Group>
                            </UnstyledButton>
                        ))}
                    </Stack>
                </ScrollArea.Autosize>
            )}
        </Stack>
    );
};
