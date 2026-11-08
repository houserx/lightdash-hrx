import {
    applyValueMappings,
    formatItemValue,
    isCustomDimension,
    isDimension,
    isField,
    type GrafanaMappableValue,
    type GrafanaValueMapping,
    type GrafanaValueMappingResult,
    type ItemsMap,
    type MergeColumnTotal,
    type ParametersValuesMap,
    type PivotData,
    type ResultRow,
    type ResultValue,
} from '@lightdash/common';
import { canHaveWarehouseTotal } from './totals';

/** What a column header shows, before any rendering. */
export type TableColumnHeader =
    | { kind: 'override'; label: string }
    | {
          kind: 'field';
          label: string;
          tableLabel: string;
          showTableName: boolean;
      }
    | { kind: 'customDimension'; label: string }
    | { kind: 'other'; label: string };

/** What a column footer shows for the column total. */
export type TableTotalCell =
    | { kind: 'value'; value: string }
    | { kind: 'valueFromSource'; value: string; sourceLabel: string }
    | { kind: 'notComputable'; reason: string }
    | { kind: 'error'; error: unknown }
    | { kind: 'loading' }
    | null;

/** What a grouped row shows in a column for the group's subtotal. */
export type TableSubtotalCell =
    | { kind: 'value'; value: string }
    | { kind: 'error'; error: unknown }
    | { kind: 'loading' }
    | null;

export type TableModelColumn = {
    id: string;
    item: ItemsMap[string] | undefined;
    header: TableColumnHeader;
    labelOverride: string | undefined;
    isVisible: boolean;
    frozen: boolean;
    /** The configured column width in px. */
    width: number | undefined;
    /** For image columns with explicit width: the fixed width in px. */
    imageWidth: number | undefined;
    total: TableTotalCell;
    /** Grafana value mappings that replace the displayed text of a cell. */
    valueMappings: GrafanaValueMapping[] | undefined;
};

export type TableModel = {
    columns: TableModelColumn[];
    /**
     * The result rows; a cell of a column with value mappings shows the
     * mapped text in `formatted` and keeps `raw` (sorting, export) as is.
     */
    rows: ResultRow[];
    totals: Record<string, number> | undefined;
    groupedSubtotals: Record<string, Record<string, number>[]> | undefined;
    /** Present when the results are a pivot; `columns` is then empty. */
    pivotData: PivotData | undefined;
};

export type TableColumnsInput = {
    itemsMap: ItemsMap;
    selectedItemIds: string[];
    isColumnVisible: (key: string) => boolean;
    isColumnFrozen: (key: string) => boolean;
    getColumnWidth: (key: string) => number | undefined;
    getColumnValueMappings?: (key: string) => GrafanaValueMapping[] | undefined;
    showTableNames: boolean;
    getFieldLabelOverride: (key: string) => string | undefined;
    columnOrder: string[];
    totals?: Record<string, number>;
    totalsLoading?: boolean;
    totalsError?: unknown;
    /** Totals over a merged result exist only for some metric types. */
    isMergedResult?: boolean;
    /** Where each merged column's total comes from, by field id. */
    mergeColumnTotals?: Record<string, MergeColumnTotal>;
    groupedSubtotals?: Record<string, Record<string, number>[]>;
    subtotalsLoading?: boolean;
    subtotalsError?: unknown;
    parameters?: ParametersValuesMap;
};

export type TableModelInput = TableColumnsInput & {
    rows: ResultRow[];
    pivotDimensions?: string[];
    pivotData?: PivotData;
};

export const getTableColumnHeader = (
    item: ItemsMap[string] | undefined,
    headerOverride: string | undefined,
    showTableNames: boolean,
): TableColumnHeader => {
    if (headerOverride) {
        return { kind: 'override', label: headerOverride };
    }
    if (isField(item)) {
        return {
            kind: 'field',
            label: item.label,
            tableLabel: item.tableLabel,
            showTableName: showTableNames,
        };
    }
    if (isCustomDimension(item)) {
        return { kind: 'customDimension', label: item.name };
    }
    return {
        kind: 'other',
        label: item && 'displayName' in item ? item.displayName : 'Undefined',
    };
};

export const getTableImageWidth = (
    item: ItemsMap[string] | undefined,
): number | undefined => {
    if (isDimension(item) && item.image?.url) {
        const defaultWidth = 100;
        const defaultPadding = 8 * 2;
        return (item.image?.width || defaultWidth) + defaultPadding;
    }
    return undefined;
};

export const getTableTotalCell = ({
    item,
    itemId,
    totals,
    totalsLoading,
    totalsError,
    isMergedResult,
    mergeColumnTotals = {},
    parameters,
}: {
    item: ItemsMap[string] | undefined;
    itemId: string;
} & Pick<
    TableColumnsInput,
    | 'totals'
    | 'totalsLoading'
    | 'totalsError'
    | 'isMergedResult'
    | 'mergeColumnTotals'
    | 'parameters'
>): TableTotalCell => {
    const mergeTotal = mergeColumnTotals[itemId];
    if (totals?.[itemId] !== undefined) {
        const value = formatItemValue(item, totals[itemId], false, parameters);
        return mergeTotal?.from === 'sourceQuery'
            ? {
                  kind: 'valueFromSource',
                  value,
                  sourceLabel: mergeTotal.sourceLabel,
              }
            : { kind: 'value', value };
    }
    if (
        isMergedResult &&
        canHaveWarehouseTotal(item) &&
        mergeTotal?.from === null
    ) {
        return { kind: 'notComputable', reason: mergeTotal.reason };
    }
    if (totalsError && canHaveWarehouseTotal(item)) {
        return { kind: 'error', error: totalsError };
    }
    if (totalsLoading && canHaveWarehouseTotal(item)) {
        return { kind: 'loading' };
    }
    return null;
};

/**
 * The cell of a grouped row once the group's subtotal record was looked up
 * (`findMatchingSubtotal` + `getSubtotalValueFromGroup`).
 */
export const getTableSubtotalCell = ({
    item,
    subtotalValue,
    subtotalsLoading,
    subtotalsError,
    parameters,
}: {
    item: ItemsMap[string] | undefined;
    subtotalValue: number | null | undefined;
} & Pick<
    TableColumnsInput,
    'subtotalsLoading' | 'subtotalsError' | 'parameters'
>): TableSubtotalCell => {
    if (subtotalValue === null) {
        return null;
    }

    if (
        subtotalValue === undefined &&
        subtotalsError &&
        canHaveWarehouseTotal(item)
    ) {
        return { kind: 'error', error: subtotalsError };
    }

    if (
        subtotalValue === undefined &&
        subtotalsLoading &&
        canHaveWarehouseTotal(item)
    ) {
        return { kind: 'loading' };
    }

    return {
        kind: 'value',
        value: formatItemValue(item, subtotalValue, false, parameters),
    };
};

/** The ordered, deduplicated columns of a flat (non-pivoted) table. */
/** The column order with repeated fields dropped; a repeat is a saved-chart defect worth reporting. */
export const getUniqueColumnOrder = (columnOrder: string[]): string[] => [
    ...new Set(columnOrder),
];

export const buildTableColumns = ({
    itemsMap,
    selectedItemIds,
    isColumnVisible,
    isColumnFrozen,
    getColumnWidth,
    getColumnValueMappings,
    showTableNames,
    getFieldLabelOverride,
    columnOrder,
    totals,
    totalsLoading,
    totalsError,
    isMergedResult,
    mergeColumnTotals = {},
    parameters,
}: TableColumnsInput): TableModelColumn[] => {
    // Deduplicate columnOrder to prevent duplicate columns if the same field appears multiple times
    const uniqueColumnOrder = getUniqueColumnOrder(columnOrder);

    return uniqueColumnOrder.reduce<TableModelColumn[]>((acc, itemId) => {
        const item = itemsMap[itemId] as (typeof itemsMap)[number] | undefined;

        if (!selectedItemIds.includes(itemId)) {
            return acc;
        }
        const headerOverride = getFieldLabelOverride(itemId);

        const column: TableModelColumn = {
            id: itemId,
            item,
            header: getTableColumnHeader(item, headerOverride, showTableNames),
            labelOverride: headerOverride,
            isVisible: isColumnVisible(itemId),
            frozen: isColumnFrozen(itemId),
            width: getColumnWidth(itemId),
            imageWidth: getTableImageWidth(item),
            total: getTableTotalCell({
                item,
                itemId,
                totals,
                totalsLoading,
                totalsError,
                isMergedResult,
                mergeColumnTotals,
                parameters,
            }),
            valueMappings: getColumnValueMappings?.(itemId),
        };
        return [...acc, column];
    }, []);
};

const toMappableValue = (
    raw: unknown,
): { value: GrafanaMappableValue } | undefined => {
    if (
        raw === null ||
        raw === undefined ||
        typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'boolean'
    ) {
        return { value: raw };
    }
    if (typeof raw === 'bigint') return { value: String(raw) };
    // Dates, JSON and other objects have no Grafana mapping.
    return undefined;
};

/**
 * The value mapping that applies to a cell's raw value (text and colour),
 * or undefined when the column has none or none matches.
 */
export const getTableCellValueMapping = (
    value: ResultValue | undefined,
    mappings: readonly GrafanaValueMapping[] | undefined,
): GrafanaValueMappingResult | undefined => {
    if (!mappings || mappings.length === 0) return undefined;
    const mappable = toMappableValue(value?.raw);
    if (!mappable) return undefined;
    return applyValueMappings(mappable.value, mappings);
};

/**
 * The rows with each mapped cell's `formatted` replaced by the mapping's
 * text. `raw` is untouched, so sorting and export use the real value.
 */
export const applyTableValueMappings = (
    rows: ResultRow[],
    columns: Pick<TableModelColumn, 'id' | 'valueMappings'>[],
): ResultRow[] => {
    const mapped = columns.filter(
        (column) => column.valueMappings && column.valueMappings.length > 0,
    );
    if (mapped.length === 0) return rows;
    return rows.map((row) => {
        let next: ResultRow | undefined;
        mapped.forEach(({ id, valueMappings }) => {
            const cell = row[id];
            if (!cell) return;
            const text = getTableCellValueMapping(
                cell.value,
                valueMappings,
            )?.text;
            if (text === undefined) return;
            next = next ?? { ...row };
            next[id] = { ...cell, value: { ...cell.value, formatted: text } };
        });
        return next ?? row;
    });
};

/**
 * A table's data model: no React, TanStack or JSX. Totals, subtotals and
 * pivot data are inputs (the frontend fetches totals and pivots in a
 * worker); a pivoted table has `pivotData` and no flat columns, as in the
 * frontend hook.
 */
export const buildTableModel = ({
    rows,
    pivotDimensions,
    pivotData,
    ...columnsInput
}: TableModelInput): TableModel => {
    const columns =
        pivotDimensions && pivotDimensions.length > 0
            ? []
            : buildTableColumns(columnsInput);

    return {
        columns,
        rows: applyTableValueMappings(rows, columns),
        totals: columnsInput.totals,
        groupedSubtotals: columnsInput.groupedSubtotals,
        pivotData,
    };
};
