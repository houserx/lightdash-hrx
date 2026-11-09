/**
 * ENG-1799 importers: Grafana panel transformations. Grafana reshapes query results in the
 * browser; Lightdash shapes them in the chart's SQL or its chart config. Each supported
 * transformation rewrites the translated SQL (wrapping it) or sets table column config.
 *
 * - `renameByRegex` renames series: `regexp_replace` on the `series` column of a series
 *   result (CONTRACTS §1.1), with Grafana's regex and its replacement pattern.
 * - `organize` renames, hides and orders table columns in the table chart config.
 * - `filterFieldsByName` selects the columns it names around the query, and `filterByValue`
 *   filters its rows with a WHERE, for a query whose columns are named (Postgres, Ops Marts).
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

const isString = (v: unknown): v is string => typeof v === 'string';

/** A rewritten query, a reason the transformation can't apply, or null for a no-op. */
type SqlRewrite = { sql: string } | { unsupported: string } | null;

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
): SqlRewrite => {
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

/** A column name as a quoted SQL identifier, exactly as the panel query returns it. */
const sqlIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Only a result whose columns its query names (a Postgres or Ops Mart query: no known
 * shape) has fields whose Grafana names are its SQL column names. A shaped result's Grafana
 * fields are its series (and time), which aren't columns.
 */
const SHAPED_RESULT_REASON =
    'Grafana names the fields of this query by series, which are not columns of the chart SQL; filter the result in the chart SQL by hand';

/**
 * `filterFieldsByName` keeping the fields it names: `SELECT <names> FROM (<sql>)`. A name
 * pattern, a variable or an exclude list needs the result's column names, which the importer
 * doesn't know for a hand-written query, so it is reported.
 */
const filterFieldsByName = (
    sql: string,
    shape: GrafanaResultShape | undefined,
    options: Record<string, unknown>,
): SqlRewrite => {
    const include = isRecord(options.include) ? options.include : {};
    const exclude = isRecord(options.exclude) ? options.exclude : {};
    const names = Array.isArray(include.names)
        ? [...new Set(include.names.filter(isString))]
        : [];
    const pattern =
        typeof include.pattern === 'string' ? include.pattern.trim() : '';
    const excluded = Array.isArray(exclude.names)
        ? exclude.names.filter(isString)
        : [];
    if (
        names.length === 0 &&
        pattern === '' &&
        excluded.length === 0 &&
        options.byVariable !== true
    ) {
        return null;
    }
    if (shape !== undefined) return { unsupported: SHAPED_RESULT_REASON };
    if (pattern !== '' || excluded.length > 0 || options.byVariable === true) {
        return {
            unsupported:
                'it picks fields by pattern, variable or exclusion, and the importer does not know the columns of the panel query; select the columns in the chart SQL by hand',
        };
    }
    return {
        sql: `SELECT ${names
            .map(sqlIdentifier)
            .join(', ')}\nFROM (${sql}) AS filtered`,
    };
};

/**
 * A matcher's value as a SQL literal: a number (or numeric string, as Grafana compares
 * loosely) as a number, else a string.
 */
const sqlValue = (value: unknown): string | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value === 'string') {
        return value.trim() !== '' && Number.isFinite(Number(value))
            ? String(Number(value))
            : sqlStringLiteral(value);
    }
    return undefined;
};

const COMPARISONS: Record<string, string> = {
    equal: '=',
    notEqual: '<>',
    greater: '>',
    greaterOrEqual: '>=',
    lower: '<',
    lowerOrEqual: '<=',
};

/**
 * One filterByValue matcher on a column as a SQL condition (Grafana's value matchers), and
 * whether it can be NULL (a comparison on a NULL value).
 */
const valueCondition = (
    column: string,
    config: Record<string, unknown>,
): { sql: string; nullable: boolean; isNull?: true } | undefined => {
    const options = isRecord(config.options) ? config.options : {};
    const id = typeof config.id === 'string' ? config.id : '';
    if (id === 'isNull') {
        return { sql: `${column} IS NULL`, nullable: false, isNull: true };
    }
    if (id === 'isNotNull') {
        return { sql: `${column} IS NOT NULL`, nullable: false };
    }
    if (id in COMPARISONS) {
        const value = sqlValue(options.value);
        return value === undefined
            ? undefined
            : { sql: `${column} ${COMPARISONS[id]} ${value}`, nullable: true };
    }
    if (id === 'range') {
        const from = sqlValue(options.from);
        const to = sqlValue(options.to);
        return from === undefined || to === undefined
            ? undefined
            : {
                  sql: `(${column} > ${from} AND ${column} < ${to})`,
                  nullable: true,
              };
    }
    if (id === 'regex' && typeof options.value === 'string') {
        return {
            sql: `CAST(${column} AS VARCHAR) ~ ${sqlStringLiteral(
                options.value,
            )}`,
            nullable: true,
        };
    }
    return undefined;
};

/**
 * `filterByValue` as a WHERE around the query: its matchers joined by OR (`match: any`) or
 * AND (`all`), kept (`include`) or negated (`exclude`). Grafana's matchers are false on a
 * null value, so a negated condition that can be NULL is read as false first; with `any`
 * and an `isNull` matcher on every compared column it can't be NULL.
 */
const filterByValue = (
    sql: string,
    shape: GrafanaResultShape | undefined,
    options: Record<string, unknown>,
): SqlRewrite => {
    const filters = Array.isArray(options.filters)
        ? options.filters.filter(isRecord)
        : [];
    if (filters.length === 0) return null;
    if (shape !== undefined) return { unsupported: SHAPED_RESULT_REASON };
    const conditions = filters.map((filter) =>
        typeof filter.fieldName === 'string' &&
        filter.fieldName !== '' &&
        isRecord(filter.config)
            ? {
                  field: filter.fieldName,
                  condition: valueCondition(
                      sqlIdentifier(filter.fieldName),
                      filter.config,
                  ),
              }
            : undefined,
    );
    if (conditions.some((c) => c?.condition === undefined)) {
        return {
            unsupported:
                'one of its filters has no field or uses a matcher the importer does not translate; filter the rows in the chart SQL by hand',
        };
    }
    const parts = conditions.flatMap((c) =>
        c?.condition ? [{ field: c.field, ...c.condition }] : [],
    );
    const any = options.match !== 'all';
    const joined = parts.map((p) => p.sql).join(any ? ' OR ' : ' AND ');
    let where = joined;
    if (options.type === 'exclude') {
        const nullChecked = new Set(
            parts.filter((p) => p.isNull).map((p) => p.field),
        );
        const canBeNull = parts.some(
            (p) => p.nullable && !(any && nullChecked.has(p.field)),
        );
        where = canBeNull
            ? `NOT COALESCE(${joined}, FALSE)`
            : `NOT (${joined})`;
    }
    return { sql: `SELECT *\nFROM (${sql}) AS filtered\nWHERE ${where}` };
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
            const rewrite = (id: string, result: SqlRewrite) => {
                if (result && 'sql' in result) sql = result.sql;
                if (result && 'unsupported' in result) {
                    unsupported(id, result.unsupported);
                }
            };
            switch (t.id) {
                case 'renameByRegex':
                    rewrite(
                        t.id,
                        renameByRegex(sql, translated.shape, options),
                    );
                    break;
                case 'filterFieldsByName':
                    rewrite(
                        t.id,
                        filterFieldsByName(sql, translated.shape, options),
                    );
                    break;
                case 'filterByValue':
                    rewrite(
                        t.id,
                        filterByValue(sql, translated.shape, options),
                    );
                    break;
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
