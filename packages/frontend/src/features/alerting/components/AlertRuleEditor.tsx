// The Alert Rule editor (ENG-1799): creates a rule or edits an existing one.
// New rules start from the documented defaults (ALERT_RULE_DEFAULTS); a
// description is required. Presentational: the rule and the project's
// folders come in as props, and Save hands the full definition to onSubmit.
import {
    ALERT_CONDITION_OPERATORS,
    ALERT_ERROR_STATES,
    ALERT_NO_DATA_STATES,
    ALERT_RANGE_OPERATORS,
    ALERT_REDUCERS,
    ALERT_RULE_DEFAULTS,
    ALERT_RULE_MIN_INTERVAL,
    parsePrometheusDuration,
    type AlertConditionOperator,
    type AlertErrorState,
    type AlertNoDataState,
    type AlertReducer,
    type AlertRule,
    type AlertRuleDefinition,
    type AlertRangeOperator,
    type AlertThresholdOperator,
} from '@lightdash/common';
import {
    Button,
    Group,
    Select,
    SimpleGrid,
    Stack,
    Switch,
    Textarea,
    TextInput,
    Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useState, type FC } from 'react';
import { labelsToText, parseLabelsText } from '../utils';
import classes from './AlertRuleEditor.module.css';

export type AlertRuleEditorSpace = { uuid: string; name: string };

type Props = {
    /** The rule to edit; a new rule when absent. */
    rule?: AlertRule;
    /** The project's spaces, offered as folders. */
    spaces: AlertRuleEditorSpace[];
    /**
     * Called on Save with the whole definition: a valid body for both
     * `POST /rules` (CreateAlertRule) and `PATCH /rules/:uuid`.
     */
    onSubmit: (definition: AlertRuleDefinition) => void | Promise<unknown>;
    onCancel?: () => void;
};

type FormValues = {
    name: string;
    description: string;
    spaceUuid: string | null;
    query: string;
    valueColumn: string;
    reducer: AlertReducer;
    operator: AlertConditionOperator;
    threshold: string;
    min: string;
    max: string;
    for: string;
    keepFiringFor: string;
    interval: string;
    timeRange: string;
    noDataState: AlertNoDataState;
    errorState: AlertErrorState;
    labels: string;
    annotations: string;
    paused: boolean;
    shadow: boolean;
};

const REDUCER_LABELS: Record<AlertReducer, string> = {
    last: 'Last',
    mean: 'Mean',
    max: 'Max',
    min: 'Min',
    sum: 'Sum',
    count: 'Count',
};

const OPERATOR_LABELS: Record<AlertConditionOperator, string> = {
    '>': 'Is above (>)',
    '<': 'Is below (<)',
    '>=': 'Is at or above (>=)',
    '<=': 'Is at or below (<=)',
    '==': 'Equals (==)',
    '!=': 'Does not equal (!=)',
    within_range: 'Is within range',
    outside_range: 'Is outside range',
};

const NO_DATA_STATE_LABELS: Record<AlertNoDataState, string> = {
    nodata: 'No data',
    normal: 'Normal',
    alerting: 'Alerting',
    keep_last: 'Keep last state',
};

const ERROR_STATE_LABELS: Record<AlertErrorState, string> = {
    error: 'Error',
    alerting: 'Alerting',
    keep_last: 'Keep last state',
};

const isRangeOperator = (
    operator: AlertConditionOperator,
): operator is AlertRangeOperator =>
    (ALERT_RANGE_OPERATORS as readonly string[]).includes(operator);

const toFormValues = (rule: AlertRule | undefined): FormValues => {
    const condition = rule?.condition;
    const isRange = condition !== undefined && 'min' in condition;
    return {
        name: rule?.name ?? '',
        description: rule?.description ?? '',
        spaceUuid: rule?.spaceUuid ?? null,
        query: rule?.query ?? '',
        valueColumn: rule?.valueColumn ?? ALERT_RULE_DEFAULTS.valueColumn,
        reducer: rule?.reducer ?? ALERT_RULE_DEFAULTS.reducer,
        operator: condition?.operator ?? '>',
        threshold: condition && !isRange ? String(condition.threshold) : '',
        min: condition && isRange ? String(condition.min) : '',
        max: condition && isRange ? String(condition.max) : '',
        for: rule?.for ?? ALERT_RULE_DEFAULTS.for,
        keepFiringFor: rule?.keepFiringFor ?? ALERT_RULE_DEFAULTS.keepFiringFor,
        interval: rule?.interval ?? ALERT_RULE_DEFAULTS.interval,
        timeRange: rule?.timeRange ?? ALERT_RULE_DEFAULTS.timeRange,
        noDataState: rule?.noDataState ?? ALERT_RULE_DEFAULTS.noDataState,
        errorState: rule?.errorState ?? ALERT_RULE_DEFAULTS.errorState,
        labels: labelsToText(rule?.labels ?? {}),
        annotations: labelsToText(rule?.annotations ?? {}),
        paused: rule?.paused ?? ALERT_RULE_DEFAULTS.paused,
        shadow: rule?.shadow ?? ALERT_RULE_DEFAULTS.shadow,
    };
};

/** A finite number from a text field, or undefined when blank or invalid. */
const toNumber = (value: string): number | undefined => {
    if (value.trim() === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};

const required = (label: string) => (value: string) =>
    value.trim() === '' ? `${label} is required` : null;

const duration = (label: string) => (value: string) => {
    try {
        parsePrometheusDuration(value.trim());
        return null;
    } catch {
        return `${label} must be a duration such as 30s, 5m or 1h30m`;
    }
};

const keyValueLines = (value: string) => parseLabelsText(value).error ?? null;

const numberWhen =
    (label: string, when: (values: FormValues) => boolean) =>
    (value: string, values: FormValues) =>
        when(values) && toNumber(value) === undefined
            ? `${label} must be a number`
            : null;

const toDefinition = (values: FormValues): AlertRuleDefinition => ({
    name: values.name.trim(),
    description: values.description.trim(),
    spaceUuid: values.spaceUuid,
    labels: parseLabelsText(values.labels).labels ?? {},
    annotations: parseLabelsText(values.annotations).labels ?? {},
    query: values.query,
    valueColumn: values.valueColumn.trim(),
    reducer: values.reducer,
    condition: isRangeOperator(values.operator)
        ? {
              operator: values.operator,
              min: toNumber(values.min) ?? 0,
              max: toNumber(values.max) ?? 0,
          }
        : {
              operator: values.operator as AlertThresholdOperator,
              threshold: toNumber(values.threshold) ?? 0,
          },
    for: values.for.trim(),
    keepFiringFor: values.keepFiringFor.trim(),
    interval: values.interval.trim(),
    timeRange: values.timeRange.trim(),
    noDataState: values.noDataState,
    errorState: values.errorState,
    paused: values.paused,
    shadow: values.shadow,
});

export const AlertRuleEditor: FC<Props> = ({
    rule,
    spaces,
    onSubmit,
    onCancel,
}) => {
    const [isSaving, setIsSaving] = useState(false);
    const form = useForm<FormValues>({
        initialValues: toFormValues(rule),
        validate: {
            name: required('Name'),
            description: required('Description'),
            query: required('Query'),
            valueColumn: required('Value column'),
            threshold: numberWhen(
                'Threshold',
                (values) => !isRangeOperator(values.operator),
            ),
            min: numberWhen('Min', (values) =>
                isRangeOperator(values.operator),
            ),
            max: (value, values) => {
                if (!isRangeOperator(values.operator)) return null;
                const max = toNumber(value);
                if (max === undefined) return 'Max must be a number';
                const min = toNumber(values.min);
                return min !== undefined && max <= min
                    ? 'Max must be greater than Min'
                    : null;
            },
            for: duration('For'),
            keepFiringFor: duration('Keep firing for'),
            interval: (value) => {
                const error = duration('Evaluate every')(value);
                if (error) return error;
                return parsePrometheusDuration(value.trim()) <
                    parsePrometheusDuration(ALERT_RULE_MIN_INTERVAL)
                    ? `Evaluate every must be at least ${ALERT_RULE_MIN_INTERVAL}`
                    : null;
            },
            timeRange: duration('Time range'),
            labels: keyValueLines,
            annotations: keyValueLines,
        },
    });

    const handleSubmit = form.onSubmit(async (values) => {
        setIsSaving(true);
        try {
            await onSubmit(toDefinition(values));
        } finally {
            setIsSaving(false);
        }
    });

    const isRange = isRangeOperator(form.values.operator);

    return (
        <form onSubmit={handleSubmit} noValidate>
            <Stack gap="md">
                <Title order={2}>
                    {rule ? `Edit ${rule.name}` : 'New Alert Rule'}
                </Title>
                <TextInput label="Name" {...form.getInputProps('name')} />
                <Textarea
                    label="Description"
                    description="What this rule watches and why it matters."
                    autosize
                    minRows={2}
                    {...form.getInputProps('description')}
                />
                <Select
                    label="Folder"
                    placeholder="No folder"
                    clearable
                    searchable
                    data={spaces.map((space) => ({
                        value: space.uuid,
                        label: space.name,
                    }))}
                    {...form.getInputProps('spaceUuid')}
                />
                <Textarea
                    label="Query"
                    description="SQL returning one row per series: label columns and a value column."
                    autosize
                    minRows={4}
                    classNames={{ input: classes.queryInput }}
                    {...form.getInputProps('query')}
                />
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                    <TextInput
                        label="Value column"
                        {...form.getInputProps('valueColumn')}
                    />
                    <Select
                        label="Reducer"
                        allowDeselect={false}
                        data={ALERT_REDUCERS.map((reducer) => ({
                            value: reducer,
                            label: REDUCER_LABELS[reducer],
                        }))}
                        {...form.getInputProps('reducer')}
                    />
                    <Select
                        label="Condition"
                        allowDeselect={false}
                        data={ALERT_CONDITION_OPERATORS.map((operator) => ({
                            value: operator,
                            label: OPERATOR_LABELS[operator],
                        }))}
                        {...form.getInputProps('operator')}
                    />
                </SimpleGrid>
                {isRange ? (
                    <SimpleGrid cols={2}>
                        <TextInput
                            label="Min"
                            inputMode="decimal"
                            {...form.getInputProps('min')}
                        />
                        <TextInput
                            label="Max"
                            inputMode="decimal"
                            {...form.getInputProps('max')}
                        />
                    </SimpleGrid>
                ) : (
                    <TextInput
                        label="Threshold"
                        inputMode="decimal"
                        {...form.getInputProps('threshold')}
                    />
                )}
                <SimpleGrid cols={{ base: 1, sm: 4 }}>
                    <TextInput
                        label="Evaluate every"
                        {...form.getInputProps('interval')}
                    />
                    <TextInput
                        label="Time range"
                        {...form.getInputProps('timeRange')}
                    />
                    <TextInput label="For" {...form.getInputProps('for')} />
                    <TextInput
                        label="Keep firing for"
                        {...form.getInputProps('keepFiringFor')}
                    />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Select
                        label="When the query returns no data"
                        allowDeselect={false}
                        data={ALERT_NO_DATA_STATES.map((state) => ({
                            value: state,
                            label: NO_DATA_STATE_LABELS[state],
                        }))}
                        {...form.getInputProps('noDataState')}
                    />
                    <Select
                        label="When the query fails"
                        allowDeselect={false}
                        data={ALERT_ERROR_STATES.map((state) => ({
                            value: state,
                            label: ERROR_STATE_LABELS[state],
                        }))}
                        {...form.getInputProps('errorState')}
                    />
                </SimpleGrid>
                <Textarea
                    label="Labels"
                    description="One key=value per line."
                    autosize
                    minRows={2}
                    {...form.getInputProps('labels')}
                />
                <Textarea
                    label="Annotations"
                    description="One key=value per line, e.g. summary=…"
                    autosize
                    minRows={2}
                    {...form.getInputProps('annotations')}
                />
                <Group>
                    <Switch
                        label="Paused"
                        {...form.getInputProps('paused', { type: 'checkbox' })}
                    />
                    <Switch
                        label="Shadow (evaluate without notifying)"
                        {...form.getInputProps('shadow', { type: 'checkbox' })}
                    />
                </Group>
                <Group justify="flex-end">
                    {onCancel && (
                        <Button variant="default" onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    <Button type="submit" loading={isSaving}>
                        Save
                    </Button>
                </Group>
            </Stack>
        </form>
    );
};
