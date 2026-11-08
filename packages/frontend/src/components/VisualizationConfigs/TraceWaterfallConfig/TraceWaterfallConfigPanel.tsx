import { type TraceWaterfallChart } from '@lightdash/common';
import { Select, Stack } from '@mantine/core';
import { useMemo, type FC } from 'react';
import { Config } from '../common/Config';

/** A field a trace waterfall span column can bind to. */
export type TraceWaterfallConfigField = {
    id: string;
    label: string;
};

type Props = {
    config: TraceWaterfallChart;
    fields: TraceWaterfallConfigField[];
    onChange: (config: TraceWaterfallChart) => void;
};

type FieldBindingKey = keyof TraceWaterfallChart;

/** One picker per span column, in the order of the `trace()` columns. */
const FIELD_BINDINGS: ReadonlyArray<{
    key: FieldBindingKey;
    label: string;
    description?: string;
}> = [
    { key: 'traceIdFieldId', label: 'Trace ID field' },
    { key: 'spanIdFieldId', label: 'Span ID field' },
    { key: 'parentSpanIdFieldId', label: 'Parent span ID field' },
    { key: 'serviceFieldId', label: 'Service field' },
    { key: 'nameFieldId', label: 'Span name field' },
    { key: 'startFieldId', label: 'Start field' },
    {
        key: 'durationMsFieldId',
        label: 'Duration field',
        description: 'In milliseconds',
    },
    { key: 'statusFieldId', label: 'Status field' },
    {
        key: 'attributesFieldId',
        label: 'Attributes field',
        description: 'A JSON object of span attributes',
    },
];

/**
 * Config panel for a trace waterfall chart: binds each span column to a
 * result field. A cleared picker leaves the column to be detected by name.
 */
export const TraceWaterfallConfigPanel: FC<Props> = ({
    config,
    fields,
    onChange,
}) => {
    const fieldOptions = useMemo(
        () => fields.map((field) => ({ value: field.id, label: field.label })),
        [fields],
    );

    return (
        <Stack gap="md">
            <Config>
                <Config.Section>
                    <Config.Heading>Span fields</Config.Heading>
                    {FIELD_BINDINGS.map(({ key, label, description }) => (
                        <Select
                            key={key}
                            size="xs"
                            label={label}
                            description={description}
                            placeholder="Detect automatically"
                            data={fieldOptions}
                            value={config[key] ?? null}
                            clearable
                            searchable
                            // Mount the options only while open, so the
                            // label names the picker alone.
                            comboboxProps={{ keepMounted: false }}
                            onChange={(value) =>
                                onChange({
                                    ...config,
                                    [key]: value ?? undefined,
                                })
                            }
                        />
                    ))}
                </Config.Section>
            </Config>
        </Stack>
    );
};
