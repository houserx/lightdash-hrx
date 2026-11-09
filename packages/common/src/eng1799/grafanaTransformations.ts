/**
 * ENG-1799 importers: Grafana panel transformations. Grafana reshapes query results in the
 * browser; Lightdash shapes them in the chart's SQL or its chart config. Each supported
 * transformation rewrites the translated SQL (wrapping it) or sets table column config.
 *
 * - `renameByRegex` renames series: `regexp_replace` on the `series` column of a series
 *   result (CONTRACTS §1.1), with Grafana's regex and its replacement pattern.
 * - `organize` renames, hides and orders table columns in the table chart config.
 *
 * Disabled transformations are skipped. Transformations this module does not know yet are
 * left as they are.
 */
import { ChartKind } from '../types/savedCharts';
import type { VizColumnsConfig } from '../visualizations/types';
import type { GrafanaResultShape } from './grafanaQuery';
import type { ImportWarning } from './importWarnings';

export type GrafanaTransformation = {
    id?: unknown;
    disabled?: unknown;
    options?: unknown;
};

export type GrafanaTransformationsResult = {
    sql: string;
    /** Table column config; empty unless the panel organizes its columns. */
    columns: VizColumnsConfig;
    warnings: ImportWarning[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const sqlStringLiteral = (value: string): string =>
    `'${value.replace(/'/g, "''")}'`;

/** The columns of each result shape that carries series names, in order (CONTRACTS §1.1). */
const SERIES_COLUMNS: Partial<Record<GrafanaResultShape, string[]>> = {
    series: ['"timestamp"', '"value"', 'labels'],
    number: ['"value"', 'labels'],
};

/**
 * Grafana's regex option: `/pattern/flags` or a bare pattern (no flags). Of the JavaScript
 * flags, `g` (replace every match) and `i` (ignore case) change a single-line series name and
 * map to the SQL flags of the same name.
 */
const parseRegex = (regex: string): { pattern: string; flags: string } => {
    const match = /^\/(.*)\/([a-z]*)$/s.exec(regex);
    if (!match) return { pattern: regex, flags: '' };
    const flags = ['g', 'i'].filter((flag) => match[2].includes(flag)).join('');
    return { pattern: match[1], flags };
};

/**
 * A JavaScript replacement pattern as a SQL `regexp_replace` replacement: `$1`…`$9` become
 * `\1`…`\9`, `$&` becomes `\&`, `$$` a literal `$`, and a literal backslash is escaped.
 */
const sqlReplacement = (pattern: string): string =>
    pattern.replace(/\\|\$(\$|&|\d)/g, (token, ref: string | undefined) => {
        if (token === '\\') return '\\\\';
        if (ref === '$') return '$';
        return `\\${ref}`;
    });

const renameByRegex = (
    sql: string,
    shape: GrafanaResultShape | undefined,
    options: Record<string, unknown>,
): { sql: string } | { unsupported: string } | null => {
    const regex = typeof options.regex === 'string' ? options.regex : '';
    if (regex === '') return null;
    const others = shape ? SERIES_COLUMNS[shape] : undefined;
    if (!others) {
        return {
            unsupported:
                'it renames fields by name, and the importer renames only the series of a series result; rename the columns in the chart SQL by hand',
        };
    }
    const { pattern, flags } = parseRegex(regex);
    const replacement =
        typeof options.renamePattern === 'string' ? options.renamePattern : '';
    const args = [
        'series',
        sqlStringLiteral(pattern),
        sqlStringLiteral(sqlReplacement(replacement)),
        ...(flags ? [sqlStringLiteral(flags)] : []),
    ];
    return {
        sql: `SELECT ${others.join(', ')}, regexp_replace(${args.join(
            ', ',
        )}) AS series\nFROM (${sql}) AS renamed`,
    };
};

/** The string-keyed entries of an organize option map. */
const entries = <T>(
    value: unknown,
    keep: (v: unknown) => v is T,
): [string, T][] =>
    isRecord(value)
        ? Object.entries(value).filter((entry): entry is [string, T] =>
              keep(entry[1]),
          )
        : [];

const isString = (v: unknown): v is string => typeof v === 'string';
const isTrue = (v: unknown): v is true => v === true;
const isIndex = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Organize's column config: every column it names gets its label (`renameByName`, else the
 * name), its visibility (`excludeByName` hides) and its position (`indexByName`). Columns it
 * doesn't name keep the table's defaults.
 */
const organizeColumns = (
    columns: VizColumnsConfig,
    options: Record<string, unknown>,
): VizColumnsConfig => {
    const labels = new Map(
        entries(options.renameByName, isString).filter(
            ([, label]) => label.trim() !== '',
        ),
    );
    const hidden = new Set(
        entries(options.excludeByName, isTrue).map(([name]) => name),
    );
    const order = new Map(entries(options.indexByName, isIndex));
    const names = [
        ...new Set([...order.keys(), ...labels.keys(), ...hidden]),
    ].sort();
    const next: VizColumnsConfig = { ...columns };
    names.forEach((name) => {
        const current = next[name];
        const position = order.get(name) ?? current?.order;
        next[name] = {
            reference: name,
            label: labels.get(name) ?? current?.label ?? name,
            visible: !hidden.has(name) && (current?.visible ?? true),
            frozen: current?.frozen ?? false,
            ...(position === undefined ? {} : { order: position }),
        };
    });
    return next;
};

/**
 * Applies a panel's transformations, in order, to its translated SQL (whose columns `shape`
 * names) and to the config of its chart kind. A supported transformation that can't apply
 * to this result or chart kind is a `transformation-unsupported` warning naming it.
 */
export const applyGrafanaTransformations = (
    transformations: unknown,
    translated: { sql: string; shape?: GrafanaResultShape },
    kind: ChartKind,
): GrafanaTransformationsResult => {
    let { sql } = translated;
    let columns: VizColumnsConfig = {};
    const warnings: ImportWarning[] = [];
    const unsupported = (id: string, reason: string) =>
        warnings.push({
            code: 'transformation-unsupported',
            message: `The ${id} transformation is not imported: ${reason}`,
        });
    (Array.isArray(transformations) ? transformations : [])
        .filter(isRecord)
        .filter((t: GrafanaTransformation) => t.disabled !== true)
        .forEach((t: GrafanaTransformation) => {
            const options = isRecord(t.options) ? t.options : {};
            switch (t.id) {
                case 'renameByRegex': {
                    const renamed = renameByRegex(
                        sql,
                        translated.shape,
                        options,
                    );
                    if (renamed && 'sql' in renamed) sql = renamed.sql;
                    if (renamed && 'unsupported' in renamed) {
                        unsupported(t.id, renamed.unsupported);
                    }
                    break;
                }
                case 'organize':
                    // An organize that names no column changes nothing.
                    if (
                        Object.keys(organizeColumns({}, options)).length === 0
                    ) {
                        break;
                    }
                    if (kind === ChartKind.TABLE) {
                        columns = organizeColumns(columns, options);
                    } else {
                        unsupported(
                            t.id,
                            `only table charts rename, hide and order columns, and this panel is a ${kind} chart`,
                        );
                    }
                    break;
                default:
                    break;
            }
        });
    return { sql, columns, warnings };
};
