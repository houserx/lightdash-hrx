// The Alert Rules list (ENG-1799): one row per rule with its state, labels,
// folder and a 'Managed in git' badge, filtered by state, label and folder.
// Presentational: the rules and folders come in as props; opening a rule is
// a callback.
import { type AlertRuleState, type AlertRuleSummary } from '@lightdash/common';
import {
    Anchor,
    Badge,
    Group,
    Select,
    Stack,
    Table,
    Text,
    TextInput,
} from '@mantine/core';
import { useMemo, useState, type FC } from 'react';
import { ALERT_STATE_LABELS, matchesLabelFilter } from '../utils';
import { AlertStateBadge, ManagedInGitBadge } from './AlertBadges';
import classes from './AlertRulesList.module.css';

/** A space the rules can live in, shown as the rule's folder. */
export type AlertRuleFolder = { uuid: string; name: string };

type Props = {
    rules: AlertRuleSummary[];
    spaces: AlertRuleFolder[];
    onOpenRule: (ruleUuid: string) => void;
};

const ALL = 'all';
const NO_FOLDER = 'none';

const STATE_FILTER_ORDER: AlertRuleState[] = [
    'firing',
    'pending',
    'normal',
    'nodata',
    'error',
];

const STATE_OPTIONS = [
    { value: ALL, label: 'All' },
    ...STATE_FILTER_ORDER.map((state) => ({
        value: state,
        label: ALERT_STATE_LABELS[state],
    })),
];

export const AlertRulesList: FC<Props> = ({ rules, spaces, onOpenRule }) => {
    const [stateFilter, setStateFilter] = useState<string>(ALL);
    const [labelFilter, setLabelFilter] = useState('');
    const [folderFilter, setFolderFilter] = useState<string>(ALL);

    const folderNames = useMemo(
        () => new Map(spaces.map((space) => [space.uuid, space.name])),
        [spaces],
    );

    const folderOptions = useMemo(
        () => [
            { value: ALL, label: 'All' },
            ...spaces.map((space) => ({
                value: space.uuid,
                label: space.name,
            })),
            { value: NO_FOLDER, label: 'No folder' },
        ],
        [spaces],
    );

    const visibleRules = useMemo(
        () =>
            rules.filter((rule) => {
                if (stateFilter !== ALL && rule.state !== stateFilter)
                    return false;
                if (folderFilter === NO_FOLDER && rule.spaceUuid) return false;
                if (
                    folderFilter !== ALL &&
                    folderFilter !== NO_FOLDER &&
                    rule.spaceUuid !== folderFilter
                )
                    return false;
                return matchesLabelFilter(rule.labels, labelFilter);
            }),
        [rules, stateFilter, folderFilter, labelFilter],
    );

    return (
        <Stack gap="md">
            <Group gap="sm" align="flex-end">
                <Select
                    label="State"
                    data={STATE_OPTIONS}
                    value={stateFilter}
                    onChange={(value) => setStateFilter(value ?? ALL)}
                    allowDeselect={false}
                    w={160}
                />
                <TextInput
                    label="Label"
                    placeholder="team=infra"
                    value={labelFilter}
                    onChange={(event) =>
                        setLabelFilter(event.currentTarget.value)
                    }
                    w={240}
                />
                <Select
                    label="Folder"
                    data={folderOptions}
                    value={folderFilter}
                    onChange={(value) => setFolderFilter(value ?? ALL)}
                    allowDeselect={false}
                    searchable
                    w={200}
                />
            </Group>
            <Table highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>State</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>Labels</Table.Th>
                        <Table.Th>Folder</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {visibleRules.map((rule) => (
                        <Table.Tr
                            key={rule.uuid}
                            className={classes.row}
                            onClick={() => onOpenRule(rule.uuid)}
                        >
                            <Table.Td>
                                <AlertStateBadge state={rule.state} />
                            </Table.Td>
                            <Table.Td>
                                <Group gap="xs" wrap="nowrap">
                                    <Anchor component="button" fw={500}>
                                        {rule.name}
                                    </Anchor>
                                    {rule.managed && <ManagedInGitBadge />}
                                    {rule.paused && (
                                        <Badge
                                            color="gray"
                                            variant="light"
                                            radius="sm"
                                        >
                                            Paused
                                        </Badge>
                                    )}
                                    {rule.shadow && (
                                        <Badge
                                            color="indigo"
                                            variant="light"
                                            radius="sm"
                                        >
                                            Shadow
                                        </Badge>
                                    )}
                                </Group>
                            </Table.Td>
                            <Table.Td>
                                <Group gap={4}>
                                    {Object.entries(rule.labels).map(
                                        ([key, value]) => (
                                            <Badge
                                                key={key}
                                                color="gray"
                                                variant="outline"
                                                radius="sm"
                                                tt="none"
                                            >
                                                {`${key}=${value}`}
                                            </Badge>
                                        ),
                                    )}
                                </Group>
                            </Table.Td>
                            <Table.Td>
                                <Text size="sm">
                                    {(rule.spaceUuid &&
                                        folderNames.get(rule.spaceUuid)) ??
                                        '—'}
                                </Text>
                            </Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
            {visibleRules.length === 0 && (
                <Text c="dimmed" size="sm" ta="center">
                    {rules.length === 0
                        ? 'No Alert Rules yet.'
                        : 'No Alert Rules match these filters.'}
                </Text>
            )}
        </Stack>
    );
};
