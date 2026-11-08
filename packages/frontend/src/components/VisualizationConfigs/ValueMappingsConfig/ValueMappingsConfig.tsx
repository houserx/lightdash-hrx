import {
    GRAFANA_NAMED_COLORS,
    resolveGrafanaColor,
    type GrafanaSpecialValueMatch,
    type GrafanaValueMapping,
    type GrafanaValueMappingResult,
} from '@lightdash/common';
import {
    ActionIcon,
    Button,
    Group,
    NumberInput,
    Paper,
    Select,
    Stack,
    TextInput,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { type FC } from 'react';
import MantineIcon from '../../common/MantineIcon';
import ColorSelector from '../ColorSelector';
import { Config } from '../common/Config';

type MappingType = GrafanaValueMapping['type'];

const TYPE_OPTIONS: { value: MappingType; label: string }[] = [
    { value: 'value', label: 'Value' },
    { value: 'range', label: 'Range' },
    { value: 'regex', label: 'Regex' },
    { value: 'special', label: 'Special' },
];

const SPECIAL_OPTIONS: { value: GrafanaSpecialValueMatch; label: string }[] = [
    { value: 'null', label: 'Null' },
    { value: 'nan', label: 'NaN' },
    { value: 'null+nan', label: 'Null and NaN' },
    { value: 'true', label: 'True' },
    { value: 'false', label: 'False' },
    { value: 'empty', label: 'Empty' },
];

// Grafana's base hues, offered as swatches
const SWATCHES = ['green', 'yellow', 'orange', 'red', 'blue', 'purple'].map(
    (name) => GRAFANA_NAMED_COLORS[name],
);

const getResult = (mapping: GrafanaValueMapping): GrafanaValueMappingResult => {
    if (mapping.type === 'value') {
        return Object.values(mapping.options)[0] ?? {};
    }
    return mapping.options.result;
};

const withResult = (
    mapping: GrafanaValueMapping,
    result: GrafanaValueMappingResult,
): GrafanaValueMapping => {
    switch (mapping.type) {
        case 'value': {
            const [key = ''] = Object.keys(mapping.options);
            return { type: 'value', options: { [key]: result } };
        }
        case 'range':
            return { ...mapping, options: { ...mapping.options, result } };
        case 'regex':
            return { ...mapping, options: { ...mapping.options, result } };
        case 'special':
            return { ...mapping, options: { ...mapping.options, result } };
    }
};

const toType = (
    mapping: GrafanaValueMapping,
    type: MappingType,
): GrafanaValueMapping => {
    if (mapping.type === type) return mapping;
    const result = getResult(mapping);
    switch (type) {
        case 'value':
            return { type, options: { '': result } };
        case 'range':
            return { type, options: { from: null, to: null, result } };
        case 'regex':
            return { type, options: { pattern: '', result } };
        case 'special':
        default:
            return { type: 'special', options: { match: 'null', result } };
    }
};

const orderOf = (mapping: GrafanaValueMapping) =>
    getResult(mapping).index ?? Number.POSITIVE_INFINITY;

/**
 * One editor row per mapping, in the order they are tried. Like Grafana's
 * mapping editor, a value mapping with several values becomes one row per
 * value; matching is the same either way.
 */
const toRows = (mappings: readonly GrafanaValueMapping[]) =>
    mappings
        .flatMap((mapping): GrafanaValueMapping[] =>
            mapping.type === 'value'
                ? Object.entries(mapping.options).map(([key, result]) => ({
                      type: 'value',
                      options: { [key]: result },
                  }))
                : [mapping],
        )
        .map((mapping, position) => ({ mapping, position }))
        .sort(
            (a, b) =>
                orderOf(a.mapping) - orderOf(b.mapping) ||
                a.position - b.position,
        )
        .map(({ mapping }) => mapping);

// Each row's result index is its position, the order Grafana tries them in
const fromRows = (rows: GrafanaValueMapping[]): GrafanaValueMapping[] =>
    rows.map((row, index) => withResult(row, { ...getResult(row), index }));

const toBound = (value: string | number) =>
    typeof value === 'number' ? value : null;

type Props = {
    mappings: GrafanaValueMapping[] | undefined;
    onChange: (mappings: GrafanaValueMapping[]) => void;
};

/**
 * Edits a column's Grafana value mappings: each maps a value, a range, a
 * regex or a special value to display text and an optional colour.
 */
export const ValueMappingsConfig: FC<Props> = ({ mappings, onChange }) => {
    const rows = toRows(mappings ?? []);

    const setRows = (next: GrafanaValueMapping[]) => onChange(fromRows(next));

    const updateRow = (index: number, mapping: GrafanaValueMapping) =>
        setRows(rows.map((row, i) => (i === index ? mapping : row)));

    const updateResult = (
        index: number,
        patch: Partial<GrafanaValueMappingResult>,
    ) => {
        const row = rows[index];
        const result = { ...getResult(row), ...patch };
        (Object.keys(patch) as (keyof GrafanaValueMappingResult)[]).forEach(
            (key) => {
                if (result[key] === undefined) delete result[key];
            },
        );
        updateRow(index, withResult(row, result));
    };

    const renderMatch = (mapping: GrafanaValueMapping, index: number) => {
        const label = `Mapping ${index + 1}`;
        switch (mapping.type) {
            case 'value': {
                const [key = ''] = Object.keys(mapping.options);
                return (
                    <TextInput
                        size="xs"
                        flex={1}
                        placeholder="Value"
                        aria-label={`${label} value`}
                        value={key}
                        onChange={(e) =>
                            updateRow(index, {
                                type: 'value',
                                options: {
                                    [e.currentTarget.value]: getResult(mapping),
                                },
                            })
                        }
                    />
                );
            }
            case 'range':
                return (
                    <Group gap="xs" wrap="nowrap" flex={1}>
                        <NumberInput
                            size="xs"
                            placeholder="From"
                            aria-label={`${label} from`}
                            value={mapping.options.from ?? ''}
                            onChange={(value) =>
                                updateRow(index, {
                                    ...mapping,
                                    options: {
                                        ...mapping.options,
                                        from: toBound(value),
                                    },
                                })
                            }
                        />
                        <NumberInput
                            size="xs"
                            placeholder="To"
                            aria-label={`${label} to`}
                            value={mapping.options.to ?? ''}
                            onChange={(value) =>
                                updateRow(index, {
                                    ...mapping,
                                    options: {
                                        ...mapping.options,
                                        to: toBound(value),
                                    },
                                })
                            }
                        />
                    </Group>
                );
            case 'regex':
                return (
                    <TextInput
                        size="xs"
                        flex={1}
                        placeholder="Pattern"
                        aria-label={`${label} pattern`}
                        value={mapping.options.pattern}
                        onChange={(e) =>
                            updateRow(index, {
                                ...mapping,
                                options: {
                                    ...mapping.options,
                                    pattern: e.currentTarget.value,
                                },
                            })
                        }
                    />
                );
            case 'special':
            default:
                return (
                    <Select
                        size="xs"
                        flex={1}
                        aria-label={`${label} special value`}
                        data={SPECIAL_OPTIONS}
                        value={mapping.options.match}
                        allowDeselect={false}
                        onChange={(match) => {
                            if (!match) return;
                            updateRow(index, {
                                ...mapping,
                                options: {
                                    ...mapping.options,
                                    match: match as GrafanaSpecialValueMatch,
                                },
                            });
                        }}
                    />
                );
        }
    };

    return (
        <Config>
            <Config.Section>
                <Config.Group>
                    <Config.Heading>Value mappings</Config.Heading>
                    <Button
                        size="compact-sm"
                        variant="subtle"
                        leftSection="+"
                        onClick={() =>
                            setRows([
                                ...rows,
                                { type: 'value', options: { '': {} } },
                            ])
                        }
                    >
                        Add value mapping
                    </Button>
                </Config.Group>

                {rows.map((mapping, index) => {
                    const label = `Mapping ${index + 1}`;
                    const result = getResult(mapping);
                    return (
                        <Paper key={index} withBorder p="xs">
                            <Stack gap="xs">
                                <Group gap="xs" wrap="nowrap">
                                    <Select
                                        size="xs"
                                        w={100}
                                        aria-label={`${label} type`}
                                        data={TYPE_OPTIONS}
                                        value={mapping.type}
                                        allowDeselect={false}
                                        onChange={(type) => {
                                            if (!type) return;
                                            updateRow(
                                                index,
                                                toType(
                                                    mapping,
                                                    type as MappingType,
                                                ),
                                            );
                                        }}
                                    />
                                    {renderMatch(mapping, index)}
                                    <ActionIcon
                                        variant="subtle"
                                        color="gray"
                                        aria-label={`Remove mapping ${index + 1}`}
                                        onClick={() =>
                                            setRows(
                                                rows.filter(
                                                    (_, i) => i !== index,
                                                ),
                                            )
                                        }
                                    >
                                        <MantineIcon icon={IconTrash} />
                                    </ActionIcon>
                                </Group>
                                <Group gap="xs" wrap="nowrap">
                                    <ColorSelector
                                        color={
                                            result.color === undefined
                                                ? undefined
                                                : resolveGrafanaColor(
                                                      result.color,
                                                  )
                                        }
                                        swatches={SWATCHES}
                                        ariaLabel={`${label} colour`}
                                        onColorChange={(color) =>
                                            updateResult(index, { color })
                                        }
                                        onColorReset={
                                            result.color === undefined
                                                ? undefined
                                                : () =>
                                                      updateResult(index, {
                                                          color: undefined,
                                                      })
                                        }
                                        resetLabel="No colour"
                                    />
                                    <TextInput
                                        size="xs"
                                        flex={1}
                                        placeholder="Display text"
                                        aria-label={`${label} display text`}
                                        value={result.text ?? ''}
                                        onChange={(e) =>
                                            updateResult(index, {
                                                text:
                                                    e.currentTarget.value ||
                                                    undefined,
                                            })
                                        }
                                    />
                                </Group>
                            </Stack>
                        </Paper>
                    );
                })}
            </Config.Section>
        </Config>
    );
};
