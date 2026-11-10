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
 * - `calculateField` (binary mode) adds a computed column to a query whose columns are named.
 * - `reduce` aggregates with its reducers: series per series (GROUP BY series), a query whose
 *   columns are named only by `count`, the one reducer that doesn't need the column names.
 * - `merge` combines the panel's targets into one result (UNION ALL), which the panel query
 *   translation does when `mergesGrafanaTargets` says so; here it changes nothing more.
 *
 * - `convertFieldType` casts the columns it converts to number, string or boolean, for a
 *   query whose columns are named: `SELECT * REPLACE (CAST(...) AS ...)`.
 *
 * Disabled transformations are skipped. `configFromData` and any transformation this module
 * does not know are `transformation-unsupported` warnings naming them. A rewrite that changes the result's columns changes the shape the next
 * transformation sees.
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

/**
 * A rewritten query (and its new shape when it changes the columns; `shape: undefined` for
 * named columns), a reason the transformation can't apply, or null for a no-op.
 */
type SqlRewrite =
    | { sql: string; shape?: GrafanaResultShape }
    | { unsupported: string }
    | null;

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

/**
 * A binary operand: a field name, a number, or (Grafana 11) `{matcher: {id: 'byName',
 * options}}` or `{fixed}`. A numeric string is a number, as Grafana reads it when no field
 * has that name.
 */
const binaryOperand = (
    operand: unknown,
): { sql: string; name: string } | undefined => {
    if (typeof operand === 'number' && Number.isFinite(operand)) {
        return { sql: String(operand), name: String(operand) };
    }
    if (isRecord(operand)) {
        if (operand.fixed !== undefined) return binaryOperand(operand.fixed);
        const matcher = isRecord(operand.matcher) ? operand.matcher : {};
        return matcher.id === 'byName' && typeof matcher.options === 'string'
            ? binaryOperand(matcher.options)
            : undefined;
    }
    if (typeof operand !== 'string' || operand.trim() === '') return undefined;
    return Number.isFinite(Number(operand))
        ? { sql: String(Number(operand)), name: operand }
        : { sql: sqlIdentifier(operand), name: operand };
};

/**
 * Grafana's binary operators. Grafana divides in floating point, so a division multiplies by
 * 1.0 first: SQL would truncate a division of two integer columns.
 */
const BINARY_OPERATORS: Record<string, (l: string, r: string) => string> = {
    '+': (l, r) => `${l} + ${r}`,
    '-': (l, r) => `${l} - ${r}`,
    '*': (l, r) => `${l} * ${r}`,
    '/': (l, r) => `1.0 * ${l} / ${r}`,
    '%': (l, r) => `${l} % ${r}`,
    '^': (l, r) => `power(${l}, ${r})`,
};

/**
 * `calculateField` in binary mode: `SELECT *, (<left> <op> <right>) AS <alias>` around the
 * query (only the new column with `replaceFields`). Its alias defaults to Grafana's
 * `<left> <op> <right>`. The other modes (row reduce, index, unary, cumulative, window,
 * template) are reported.
 */
const calculateField = (
    sql: string,
    shape: GrafanaResultShape | undefined,
    options: Record<string, unknown>,
): SqlRewrite => {
    const mode = typeof options.mode === 'string' ? options.mode : 'reduceRow';
    if (mode !== 'binary') {
        return {
            unsupported: `the importer translates only its binary mode, and it uses ${mode}; compute the column in the chart SQL by hand`,
        };
    }
    if (shape !== undefined) {
        return {
            unsupported:
                'Grafana names the fields of this query by series, which are not columns of the chart SQL; compute the column in the chart SQL by hand',
        };
    }
    const binary = isRecord(options.binary) ? options.binary : {};
    const left = binaryOperand(binary.left);
    const right = binaryOperand(binary.right);
    const operator = typeof binary.operator === 'string' ? binary.operator : '';
    const apply = BINARY_OPERATORS[operator];
    if (!left || !right || !apply) {
        return {
            unsupported:
                'it has no field or number on one side, or an operator the importer does not translate; compute the column in the chart SQL by hand',
        };
    }
    const alias =
        typeof options.alias === 'string' && options.alias.trim() !== ''
            ? options.alias
            : `${left.name} ${operator} ${right.name}`;
    const column = `(${apply(left.sql, right.sql)}) AS ${sqlIdentifier(alias)}`;
    return {
        sql: `SELECT ${
            options.replaceFields === true ? column : `*, ${column}`
        }\nFROM (${sql}) AS calculated`,
    };
};

/**
 * Grafana's reducers that have a SQL aggregate over a series' `"value"`, with the column
 * name Grafana gives them. `first` and `last` need the series' `"timestamp"`.
 */
const REDUCERS: Record<
    string,
    { label: string; sql: string; needsTime?: true }
> = {
    mean: { label: 'Mean', sql: 'avg("value")' },
    min: { label: 'Min', sql: 'min("value")' },
    max: { label: 'Max', sql: 'max("value")' },
    sum: { label: 'Total', sql: 'sum("value")' },
    count: { label: 'Count', sql: 'count(*)' },
    range: { label: 'Range', sql: 'max("value") - min("value")' },
    distinctCount: {
        label: 'Distinct Count',
        sql: 'count(DISTINCT "value")',
    },
    first: {
        label: 'First',
        sql: 'first_value("value" ORDER BY "timestamp")',
        needsTime: true,
    },
    last: {
        label: 'Last',
        sql: 'last_value("value" ORDER BY "timestamp")',
        needsTime: true,
    },
};

/**
 * `reduce` with its reducers. In `seriesToRows` mode (Grafana's default) each series becomes
 * a row: `SELECT series AS "Field", <aggregates> ... GROUP BY series`. In `reduceFields` mode
 * one reducer keeps the series: one number per series (the `number` shape). A query whose
 * columns are named reduces only by `count` in `seriesToRows` mode: every field of a result
 * has its row count, so `count(*) AS "Count"` (one row) holds it without the column names.
 */
const reduce = (
    sql: string,
    shape: GrafanaResultShape | undefined,
    options: Record<string, unknown>,
): SqlRewrite => {
    const reducers = Array.isArray(options.reducers)
        ? [...new Set(options.reducers.filter(isString))]
        : [];
    if (reducers.length === 0) return null;
    const mode =
        typeof options.mode === 'string' ? options.mode : 'seriesToRows';
    if (mode !== 'seriesToRows' && mode !== 'reduceFields') {
        return {
            unsupported: `the importer does not know its ${mode} mode; aggregate in the chart SQL by hand`,
        };
    }
    if (shape === undefined) {
        return mode === 'seriesToRows' &&
            reducers.length === 1 &&
            reducers[0] === 'count'
            ? {
                  sql: `SELECT count(*) AS "Count"\nFROM (${sql}) AS reduced`,
              }
            : {
                  unsupported:
                      'it aggregates each field of a query whose columns the importer does not know; aggregate in the chart SQL by hand',
              };
    }
    if (shape !== 'series' && shape !== 'number') {
        return {
            unsupported:
                'the query returns log lines, which have no values to aggregate; aggregate in the chart SQL by hand',
        };
    }
    const known = reducers.map((id) => REDUCERS[id]);
    const missing = reducers.filter(
        (id, i) =>
            known[i] === undefined ||
            (known[i].needsTime === true && shape !== 'series'),
    );
    if (missing.length > 0) {
        return {
            unsupported: `the importer has no SQL aggregate for the ${missing.join(
                ', ',
            )} reducer of this query; aggregate in the chart SQL by hand`,
        };
    }
    if (options.labelsToFields === true || options.includeTimeField === true) {
        return {
            unsupported:
                'it turns labels or the time field into columns, which the importer does not translate; aggregate in the chart SQL by hand',
        };
    }
    if (mode === 'reduceFields') {
        return known.length === 1
            ? {
                  sql: `SELECT ${known[0].sql} AS "value", labels, series\nFROM (${sql}) AS reduced\nGROUP BY labels, series`,
                  shape: 'number',
              }
            : {
                  unsupported:
                      'it reduces each series with several reducers, which the importer does not translate; aggregate in the chart SQL by hand',
              };
    }
    const aggregates = known.map(
        (r) => `${r.sql} AS ${sqlIdentifier(r.label)}`,
    );
    return {
        sql: `SELECT series AS "Field", ${aggregates.join(
            ', ',
        )}\nFROM (${sql}) AS reduced\nGROUP BY series`,
        shape: undefined,
    };
};

/**
 * The SQL types of Grafana's field types (the federation engine runs DataFusion SQL). `time`
 * reads a date format or epoch milliseconds, `enum` builds a value list and `other` keeps the
 * value as an object: none has a single CAST.
 */
const CAST_TYPES: Record<string, string> = {
    number: 'DOUBLE',
    string: 'VARCHAR',
    boolean: 'BOOLEAN',
};

/**
 * `convertFieldType` as `SELECT * REPLACE (CAST(<field> AS <type>) AS <field>, ...)` around
 * the query, which keeps the columns in their order. A conversion with no field (Grafana's
 * "all fields") and a field type with no CAST are reported.
 */
const convertFieldType = (
    sql: string,
    shape: GrafanaResultShape | undefined,
    options: Record<string, unknown>,
): SqlRewrite => {
    const conversions = Array.isArray(options.conversions)
        ? options.conversions.filter(isRecord)
        : [];
    if (conversions.length === 0) return null;
    if (shape !== undefined) {
        return {
            unsupported:
                'Grafana names the fields of this query by series, which are not columns of the chart SQL; cast the column in the chart SQL by hand',
        };
    }
    const casts = new Map<string, string>();
    for (const conversion of conversions) {
        const field =
            typeof conversion.targetField === 'string'
                ? conversion.targetField
                : '';
        const type =
            typeof conversion.destinationType === 'string'
                ? conversion.destinationType
                : '';
        const sqlType = CAST_TYPES[type];
        if (field.trim() === '' || !sqlType) {
            return {
                unsupported: `one of its conversions has no field or converts to ${
                    type || 'no type'
                }, which the importer does not cast; cast the column in the chart SQL by hand`,
            };
        }
        casts.set(field, sqlType);
    }
    const replaced = [...casts].map(
        ([field, sqlType]) =>
            `CAST(${sqlIdentifier(field)} AS ${sqlType}) AS ${sqlIdentifier(
                field,
            )}`,
    );
    return {
        sql: `SELECT * REPLACE (${replaced.join(
            ', ',
        )})\nFROM (${sql}) AS converted`,
    };
};

/** Whether the panel merges its targets: an enabled `merge` transformation. */
export const mergesGrafanaTargets = (transformations: unknown): boolean =>
    Array.isArray(transformations) &&
    transformations.some(
        (t) => isRecord(t) && t.id === 'merge' && t.disabled !== true,
    );

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
    let { sql, shape } = translated;
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
                if (result && 'sql' in result) {
                    sql = result.sql;
                    if ('shape' in result) shape = result.shape;
                }
                if (result && 'unsupported' in result) {
                    unsupported(id, result.unsupported);
                }
            };
            switch (t.id) {
                case 'renameByRegex':
                    rewrite(t.id, renameByRegex(sql, shape, options));
                    break;
                case 'filterFieldsByName':
                    rewrite(t.id, filterFieldsByName(sql, shape, options));
                    break;
                case 'filterByValue':
                    rewrite(t.id, filterByValue(sql, shape, options));
                    break;
                case 'calculateField':
                    rewrite(t.id, calculateField(sql, shape, options));
                    break;
                case 'reduce':
                    rewrite(t.id, reduce(sql, shape, options));
                    break;
                case 'convertFieldType':
                    rewrite(t.id, convertFieldType(sql, shape, options));
                    break;
                case 'merge':
                    // The panel query translation already combined the targets.
                    break;
                case 'configFromData':
                    unsupported(
                        t.id,
                        'it sets field config (such as min, max or thresholds) from the values of a query, and Lightdash chart config is fixed; set it on the chart by hand',
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
                    unsupported(
                        typeof t.id === 'string' && t.id.trim() !== ''
                            ? t.id
                            : '(unnamed)',
                        'the importer has no translation for it; reshape the result in the chart SQL by hand',
                    );
                    break;
            }
        });
    return { sql, columns, warnings };
};
