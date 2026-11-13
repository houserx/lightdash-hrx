import { type LogStreamChart } from '@lightdash/common';
import { type ChartData } from '../chartData';

/** The columns a log stream reads, each bound to a field id of the data. */
export type LogStreamFieldRole = 'line' | 'timestamp' | 'level' | 'labels';

/**
 * Column names each role binds to when the config names no field, most
 * likely first. These are the long-shape columns of the logs table functions
 * (`logql()`: `timestamp, line, labels`; `cloudwatch_logs()`: `timestamp,
 * message, fields`) plus a `level` column a query may add.
 */
export const LOG_STREAM_COLUMN_NAMES: Readonly<
    Record<LogStreamFieldRole, readonly string[]>
> = {
    line: ['line', 'message'],
    timestamp: ['timestamp'],
    level: ['level'],
    labels: ['labels', 'fields'],
};

const ROLE_CONFIG_KEYS = {
    line: 'lineFieldId',
    timestamp: 'timestampFieldId',
    level: 'levelFieldId',
    labels: 'labelsFieldId',
} as const satisfies Record<LogStreamFieldRole, keyof LogStreamChart>;

/** A log stream config with its defaults filled and its fields bound. */
export type ResolvedLogStreamChartConfig = LogStreamChart &
    Required<
        Pick<LogStreamChart, 'wrapLines' | 'newestFirst' | 'showLabels'>
    > & {
        levelColors: NonNullable<LogStreamChart['levelColors']>;
    };

const fieldIdsOf = (data: ChartData): string[] => {
    const ids = new Set(Object.keys(data.fields));
    Object.keys(data.rows[0] ?? {}).forEach((id) => ids.add(id));
    return [...ids];
};

const labelOf = (data: ChartData, fieldId: string): string | undefined => {
    const label = (data.fields[fieldId] as { label?: unknown } | undefined)
        ?.label;
    return typeof label === 'string' ? label.trim().toLowerCase() : undefined;
};

/**
 * The field a role binds to by name: a field id that is the column name or
 * ends in `_<name>` (Lightdash ids are `<table>_<column>`), else a field
 * labelled with the name. Names are tried in order.
 */
export const findLogStreamField = (
    data: ChartData,
    role: LogStreamFieldRole,
    exclude: ReadonlySet<string> = new Set(),
): string | undefined => {
    const ids = fieldIdsOf(data).filter((id) => !exclude.has(id));
    for (const name of LOG_STREAM_COLUMN_NAMES[role]) {
        const byId = ids.find(
            (id) =>
                id.toLowerCase() === name ||
                id.toLowerCase().endsWith(`_${name}`),
        );
        if (byId) return byId;
        const byLabel = ids.find((id) => labelOf(data, id) === name);
        if (byLabel) return byLabel;
    }
    return undefined;
};

/**
 * Settles a log stream config against its data: a field the config names is
 * kept while the data has it; otherwise the role binds to the long-shape
 * column by name, so a logs query draws without any configuration.
 */
export const resolveLogStreamChartConfig = ({
    chartConfig,
    data,
}: {
    chartConfig: LogStreamChart | undefined;
    data: ChartData;
}): ResolvedLogStreamChartConfig => {
    const config = chartConfig ?? {};
    const available = new Set(fieldIdsOf(data));
    const bound = new Set<string>();
    const fieldIds: Partial<Record<keyof LogStreamChart, string>> = {};
    // Configured fields first, so auto-binding never takes one of them.
    const roles = Object.keys(ROLE_CONFIG_KEYS) as LogStreamFieldRole[];
    roles.forEach((role) => {
        const configured = config[ROLE_CONFIG_KEYS[role]];
        if (configured && available.has(configured)) {
            fieldIds[ROLE_CONFIG_KEYS[role]] = configured;
            bound.add(configured);
        }
    });
    roles.forEach((role) => {
        if (fieldIds[ROLE_CONFIG_KEYS[role]]) return;
        const found = findLogStreamField(data, role, bound);
        if (found) {
            fieldIds[ROLE_CONFIG_KEYS[role]] = found;
            bound.add(found);
        }
    });
    return {
        ...config,
        lineFieldId: fieldIds.lineFieldId,
        timestampFieldId: fieldIds.timestampFieldId,
        levelFieldId: fieldIds.levelFieldId,
        labelsFieldId: fieldIds.labelsFieldId,
        wrapLines: config.wrapLines ?? false,
        newestFirst: config.newestFirst ?? true,
        showLabels: config.showLabels ?? false,
        levelColors: config.levelColors ?? {},
    };
};
