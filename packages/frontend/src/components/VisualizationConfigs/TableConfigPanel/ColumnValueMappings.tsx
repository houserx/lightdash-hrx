import { friendlyName, getItemLabelWithoutTableName } from '@lightdash/common';
import { Select, Stack, Text } from '@mantine/core';
import { useMemo, useState, type FC } from 'react';
import { selectTableColumnProperties } from '../../../features/visualization/store';
import { useTableEditorActions } from '../../../hooks/tableVisualization/useTableConfig';
import {
    useVisualizationInputs,
    useVisualizationInputSelector,
} from '../../LightdashVisualization/useVisualizationContext';
import { Config } from '../common/Config';
import { ValueMappingsConfig } from '../ValueMappingsConfig/ValueMappingsConfig';

/** Picks one of the table's columns and edits its value mappings. */
export const ColumnValueMappings: FC = () => {
    const { itemsMap, resultsData } = useVisualizationInputs();
    const columnProperties = useVisualizationInputSelector(
        selectTableColumnProperties,
    );
    const { updateColumnProperty } = useTableEditorActions();

    const columns = useMemo(() => {
        const metricQuery = resultsData?.metricQuery;
        if (!metricQuery) return [];
        return [
            ...metricQuery.dimensions,
            ...metricQuery.metrics,
            ...metricQuery.tableCalculations.map((tc) => tc.name),
        ].map((fieldId) => {
            const item = itemsMap?.[fieldId];
            return {
                value: fieldId,
                label: item
                    ? getItemLabelWithoutTableName(item)
                    : friendlyName(fieldId),
            };
        });
    }, [itemsMap, resultsData]);

    const [selected, setSelected] = useState<string | null>(null);
    const fieldId =
        selected && columns.some((column) => column.value === selected)
            ? selected
            : (columns[0]?.value ?? null);

    if (!fieldId) {
        return (
            <Text c="dimmed" size="sm">
                No columns available for value mappings
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            <Config>
                <Config.Section>
                    <Select
                        size="xs"
                        label={<Config.Label>Column</Config.Label>}
                        data={columns}
                        value={fieldId}
                        allowDeselect={false}
                        searchable
                        onChange={setSelected}
                    />
                </Config.Section>
            </Config>
            <ValueMappingsConfig
                mappings={columnProperties[fieldId]?.valueMappings}
                onChange={(valueMappings) =>
                    updateColumnProperty(fieldId, {
                        valueMappings:
                            valueMappings.length > 0
                                ? valueMappings
                                : undefined,
                    })
                }
            />
        </Stack>
    );
};
