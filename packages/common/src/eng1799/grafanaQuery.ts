/**
 * ENG-1799 importers: turns Grafana panel targets into Lightdash SQL over the engine's table
 * functions (CONTRACTS §1.1), with time arguments taken from the reserved parameters
 * (CONTRACTS §2) so every chart follows the Dashboard Time Range.
 *
 * Pure: no network, no filesystem, no Lightdash API. Anything that does not translate is a
 * TODO plus a structured warning, never a silent drop.
 */
import {
    LOGQL_DEFAULT_DIRECTION,
    LOGQL_DEFAULT_LIMIT,
    TELEMETRY_SQL_FROM,
    TELEMETRY_SQL_INTERVAL,
    TELEMETRY_SQL_TO,
    type CloudWatchDimension,
    type CloudWatchMetricDataQuery,
    type LogqlDirection,
} from '../utils/telemetrySql';
import { parseTimeRangeDuration } from '../utils/timeRange';
import type { ImportWarning } from './importWarnings';

/** A Grafana datasource as `grafana_data_sources.tf` defines it. */
export type GrafanaDatasource = { uid: string; name: string; type: string };

/** A target's or panel's datasource: `{type, uid}` or the legacy name string. */
export type GrafanaDatasourceRef =
    | string
    | { type?: string; uid?: string }
    | null
    | undefined;

export type GrafanaTarget = {
    refId?: string;
    datasource?: GrafanaDatasourceRef;
    hide?: boolean;
    expr?: string;
    range?: boolean;
    instant?: boolean;
    [key: string]: unknown;
};

export type GrafanaPanelWithTargets = {
    title?: string;
    type?: string;
    datasource?: GrafanaDatasourceRef;
    targets?: GrafanaTarget[];
    [key: string]: unknown;
};

/** A dashboard `templating.list` entry, as far as query translation reads it. */
export type GrafanaTemplatingVariable = {
    name: string;
    type: string;
    query?: unknown;
    current?: { text?: unknown; value?: unknown };
    [key: string]: unknown;
};

export type GrafanaQueryContext = {
    datasources?: GrafanaDatasource[];
    variables?: GrafanaTemplatingVariable[];
    opsMarts?: {
        github?: Record<string, string>;
        sentry?: Record<string, string>;
    };
    /** The panel's datasource, used when a target names none. */
    panelDatasource?: GrafanaDatasourceRef;
};

export type GrafanaQueryTranslation = {
    sql: string | null;
    todo: string | null;
    warnings: ImportWarning[];
};

/**
 * The columns a translated target returns (CONTRACTS §1.1). Only targets with the same known
 * shape can share one result through UNION ALL.
 */
type ResultShape =
    /** `timestamp, value, labels, series`: promql, promql_instant, logql_metric, cloudwatch. */
    | 'series'
    /** `timestamp, line, labels, stream`: logql. */
    | 'log-lines';

/** A target's translation plus the shape of its result, when it has SQL. */
type TargetTranslation = GrafanaQueryTranslation & { shape?: ResultShape };

/** The Telemetry Source name for a Grafana datasource name: `Cloudwatch Staging` → `cloudwatch-staging`. */
export const telemetrySourceName = (datasourceName: string): string =>
    datasourceName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

const MIXED_DATASOURCE_UID = '-- Mixed --';

const isUsableRef = (ref: GrafanaDatasourceRef): boolean => {
    if (ref === null || ref === undefined) return false;
    if (typeof ref === 'string') {
        return ref.trim() !== '' && ref !== MIXED_DATASOURCE_UID;
    }
    if (ref.uid === MIXED_DATASOURCE_UID || ref.type === 'datasource') {
        return false;
    }
    return Boolean(ref.uid || ref.type);
};

type ResolvedDatasource = {
    /** The datasource type, when known. */
    type: string | undefined;
    /** The Telemetry Source name, when the datasource is in the known list. */
    source: string | undefined;
    /** How the reference reads in a warning. */
    label: string;
};

const resolveDatasource = (
    ref: GrafanaDatasourceRef,
    datasources: GrafanaDatasource[],
): ResolvedDatasource => {
    if (ref === null || ref === undefined) {
        return { type: undefined, source: undefined, label: 'none' };
    }
    if (typeof ref === 'string') {
        const found =
            datasources.find((ds) => ds.name === ref) ??
            datasources.find((ds) => ds.uid === ref);
        return {
            type: found?.type,
            source: found ? telemetrySourceName(found.name) : undefined,
            label: ref,
        };
    }
    // Dashboards migrated from the legacy name string can carry the name in `uid`.
    const found =
        ref.uid === undefined
            ? undefined
            : (datasources.find((ds) => ds.uid === ref.uid) ??
              datasources.find((ds) => ds.name === ref.uid));
    return {
        type: ref.type ?? found?.type,
        source: found ? telemetrySourceName(found.name) : undefined,
        label: ref.uid ?? ref.type ?? 'unknown',
    };
};

const sqlStringLiteral = (value: string): string =>
    `'${value.replace(/'/g, "''")}'`;

const targetLabel = (target: GrafanaTarget): string =>
    target.refId ? `target ${target.refId}` : 'target';

/** The reserved parameter (CONTRACTS §2) each Grafana time macro maps to. */
const TIME_MACRO_PARAMETERS: ReadonlyMap<string, string> = new Map([
    ['__interval', '__interval'],
    // Grafana widens $__rate_interval past the scrape interval; the closest reserved
    // parameter is the dashboard interval.
    ['__rate_interval', '__interval'],
    ['__range', '__range'],
]);

/** Grafana's automatic option of an interval variable: `$__auto_interval_<variable>`. */
const AUTO_INTERVAL_PREFIX = '__auto_interval_';

/**
 * A variable or macro reference: `$name`, `${name}`, `${name:format}`, `[[name]]` or
 * `[[name:format]]`. Names start with a letter or `_`, so PromQL's `$1` in label_replace is
 * left alone.
 */
const VARIABLE_REFERENCE =
    /\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)(?::([^}]*))?\}|\[\[([A-Za-z_]\w*)(?::([^\]]*))?\]\]/g;

/** A whole datasource reference that is one variable: `$ds`, `${ds}` or `[[ds]]`. */
const DATASOURCE_VARIABLE =
    /^\s*(?:\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)(?::[^}]*)?\}|\[\[([A-Za-z_]\w*)\]\])\s*$/;

/** Variable types whose value a chart viewer picks: each becomes a Lightdash parameter. */
const PARAMETER_VARIABLE_TYPES = new Set([
    'custom',
    'query',
    'textbox',
    'interval',
]);

const findVariable = (
    variables: GrafanaTemplatingVariable[],
    name: string,
): GrafanaTemplatingVariable | undefined =>
    variables.find((v) => v.name === name);

/** The current value(s) of a variable as strings: `current.value`, else `current.text`. */
const currentValues = (variable: GrafanaTemplatingVariable): string[] => {
    const pick = (value: unknown): string[] =>
        (Array.isArray(value) ? value : [value])
            .filter((v): v is string | number =>
                ['string', 'number'].includes(typeof v),
            )
            .map(String);
    const values = pick(variable.current?.value);
    return values.length > 0 ? values : pick(variable.current?.text);
};

/** A constant's value: its `query`, else its current value. */
const constantValue = (variable: GrafanaTemplatingVariable): string =>
    typeof variable.query === 'string'
        ? variable.query
        : (currentValues(variable)[0] ?? '');

/** True when the variable can hold several values (Multi-value, Include All, or an array). */
const isMultiValue = (variable: GrafanaTemplatingVariable): boolean =>
    variable.multi === true ||
    variable.includeAll === true ||
    Array.isArray(variable.current?.value) ||
    currentValues(variable).includes('$__all');

/** What a variable or macro reference becomes in the query. */
type ReferenceReplacement =
    | { kind: 'parameter'; name: string }
    | { kind: 'inline'; value: string }
    | { kind: 'keep' };

/** Reference problems, collected over one query so each warning names every reference once. */
type ReferenceFindings = {
    unmappedMacros: string[];
    undefinedVariables: string[];
    unsupportedVariables: string[];
    multiValueVariables: string[];
    formatsIgnored: string[];
};

const addOnce = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
};

/** How a query language embeds references; the default suits PromQL and LogQL text. */
type ReferenceOptions = {
    /** Escapes an inlined constant for the query text (CloudWatch: inside a JSON string). */
    escapeInline?: (value: string) => string;
    /** Undefined names that are part of the query language, kept without a warning. */
    nativeNames?: ReadonlySet<string>;
};

const replaceReference = (
    text: string,
    name: string,
    format: string | undefined,
    variables: GrafanaTemplatingVariable[],
    options: ReferenceOptions,
    findings: ReferenceFindings,
): ReferenceReplacement => {
    if (name.startsWith('__')) {
        // An interval variable's auto option follows the dashboard interval.
        const mapped = name.startsWith(AUTO_INTERVAL_PREFIX)
            ? '__interval'
            : TIME_MACRO_PARAMETERS.get(name);
        const parameter = format === undefined ? mapped : undefined;
        if (parameter === undefined) {
            addOnce(findings.unmappedMacros, text);
            return { kind: 'keep' };
        }
        return { kind: 'parameter', name: parameter };
    }
    const variable = findVariable(variables, name);
    if (variable === undefined) {
        if (!options.nativeNames?.has(name)) {
            addOnce(findings.undefinedVariables, text);
        }
        return { kind: 'keep' };
    }
    if (variable.type === 'constant') {
        const value = constantValue(variable);
        return {
            kind: 'inline',
            value: options.escapeInline ? options.escapeInline(value) : value,
        };
    }
    if (!PARAMETER_VARIABLE_TYPES.has(variable.type)) {
        addOnce(findings.unsupportedVariables, `${text} (${variable.type})`);
        return { kind: 'keep' };
    }
    if (isMultiValue(variable)) addOnce(findings.multiValueVariables, name);
    if (format !== undefined) addOnce(findings.formatsIgnored, text);
    return { kind: 'parameter', name };
};

const pushReferenceWarnings = (
    what: string,
    findings: ReferenceFindings,
    warnings: ImportWarning[],
) => {
    if (findings.unmappedMacros.length > 0) {
        warnings.push({
            code: 'query-macro-unsupported',
            message: `${what} uses ${findings.unmappedMacros.join(', ')}, with no Lightdash time parameter to map to; the query keeps the text as written and needs editing`,
        });
    }
    if (findings.undefinedVariables.length > 0) {
        warnings.push({
            code: 'variable-undefined',
            message: `${what} uses ${findings.undefinedVariables.join(', ')}, which the dashboard does not define; the query keeps the text as written and needs editing`,
        });
    }
    if (findings.unsupportedVariables.length > 0) {
        warnings.push({
            code: 'variable-unsupported',
            message: `${what} uses ${findings.unsupportedVariables.join(', ')}, a variable type with no Lightdash parameter; the query keeps the text as written and needs editing`,
        });
    }
    findings.multiValueVariables.forEach((name) => {
        warnings.push({
            code: 'variable-multi-value',
            message: `${what} uses the multi-value or All variable ${name}; the Lightdash parameter ${name} holds one value at a time`,
        });
    });
    if (findings.formatsIgnored.length > 0) {
        warnings.push({
            code: 'variable-format-ignored',
            message: `${what} formats ${findings.formatsIgnored.join(', ')}; the parameter is used as its plain value`,
        });
    }
};

const emptyFindings = (): ReferenceFindings => ({
    unmappedMacros: [],
    undefinedVariables: [],
    unsupportedVariables: [],
    multiValueVariables: [],
    formatsIgnored: [],
});

/** The SQL string expression for `text` with its references resolved (see queryExpressionSql). */
const referencesSql = (
    text: string,
    variables: GrafanaTemplatingVariable[],
    options: ReferenceOptions,
    findings: ReferenceFindings,
): string => {
    const parts: string[] = [];
    let literal = '';
    let last = 0;
    for (const match of text.matchAll(VARIABLE_REFERENCE)) {
        const [ref, plain, braced, bracedFormat, bracketed, bracketedFormat] =
            match;
        const replacement = replaceReference(
            ref,
            plain ?? braced ?? bracketed,
            bracedFormat ?? bracketedFormat,
            variables,
            options,
            findings,
        );
        literal += text.slice(last, match.index);
        last = match.index + ref.length;
        if (replacement.kind === 'keep') {
            literal += ref;
        } else if (replacement.kind === 'inline') {
            literal += replacement.value;
        } else {
            if (literal !== '') parts.push(sqlStringLiteral(literal));
            parts.push(`\${ld.parameters.${replacement.name}}`);
            literal = '';
        }
    }
    literal += text.slice(last);
    if (literal !== '' || parts.length === 0) {
        parts.push(sqlStringLiteral(literal));
    }
    return parts.join(' || ');
};

/**
 * A query expression as a SQL string expression, with Grafana's variables and macros
 * resolved:
 * - `$__interval`, `${__interval}`, `$__rate_interval` and `$__range` become the reserved
 *   parameters (CONTRACTS §2), and `$__auto_interval_<var>` follows `__interval`;
 * - a custom, query, textbox or interval variable (`$env`, `${env}`, `[[env]]`) becomes the
 *   Lightdash parameter of the same name, with a `variable-multi-value` warning when it can
 *   hold several values;
 * - a constant is inlined.
 * Parameters are concatenated into the literal (`'up{env="' || ${ld.parameters.env} || '"}'`);
 * Lightdash substitutes string parameters as quoted literals, so the engine folds them into one
 * string. Any other macro, an undefined variable or a variable of another type stays in the
 * query text as written and gets a warning.
 */
const queryExpressionSql = (
    expr: string,
    what: string,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
    options: ReferenceOptions = {},
): string => {
    const findings = emptyFindings();
    const sql = referencesSql(expr, variables, options, findings);
    pushReferenceWarnings(what, findings, warnings);
    return sql;
};

/** Grafana's legend label reference, `{{status}}` or `{{ status }}` (as Grafana parses it). */
const LEGEND_LABEL = /\{\{\s*(.+?)\s*\}\}/g;

/** Grafana's automatic legend: the series is named by its labels, as the engine names it. */
const AUTO_LEGEND = '__auto';

/**
 * A target's `legendFormat` as a SQL expression for the `series` column, or undefined when
 * the engine's own series name is kept (no legend, an empty one, or `__auto`). Each
 * `{{label}}` reads `label(labels, 'label')` (CONTRACTS §1.1), empty when the series has no
 * such label, as Grafana renders it; dashboard variables in the text resolve as in the query.
 */
const legendSeriesSql = (
    target: GrafanaTarget,
    what: string,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
): string | undefined => {
    const { legendFormat } = target;
    if (
        typeof legendFormat !== 'string' ||
        legendFormat.trim() === '' ||
        legendFormat.trim() === AUTO_LEGEND
    ) {
        return undefined;
    }
    const findings = emptyFindings();
    const parts: string[] = [];
    let last = 0;
    const pushText = (text: string) => {
        if (text !== '') {
            parts.push(referencesSql(text, variables, {}, findings));
        }
    };
    for (const match of legendFormat.matchAll(LEGEND_LABEL)) {
        pushText(legendFormat.slice(last, match.index));
        last = match.index + match[0].length;
        parts.push(
            `COALESCE(label(labels, ${sqlStringLiteral(match[1])}), '')`,
        );
    }
    pushText(legendFormat.slice(last));
    pushReferenceWarnings(`The legend of ${what}`, findings, warnings);
    return parts.join(' || ');
};

/**
 * A datasource reference that is a datasource variable (`${datasource}`) becomes the
 * datasource the variable picks: its current value (a uid or a name), else its current text,
 * else the one datasource of the variable's type. Other references are returned as they are.
 */
const resolveDatasourceVariable = (
    ref: GrafanaDatasourceRef,
    ctx: GrafanaQueryContext,
    what: string,
    warnings: ImportWarning[],
): GrafanaDatasourceRef => {
    const text = typeof ref === 'string' ? ref : ref?.uid;
    const match = text === undefined ? null : DATASOURCE_VARIABLE.exec(text);
    if (match === null) return ref;
    const name = match[1] ?? match[2] ?? match[3];
    const variable = findVariable(ctx.variables ?? [], name);
    if (variable === undefined || variable.type !== 'datasource') return ref;
    const datasources = ctx.datasources ?? [];
    const values = [
        ...currentValues(variable),
        ...(typeof variable.current?.text === 'string'
            ? [variable.current.text]
            : []),
    ];
    const ofType =
        typeof variable.query === 'string'
            ? datasources.filter((ds) => ds.type === variable.query)
            : [];
    const picked = values
        .map(
            (value) =>
                datasources.find((ds) => ds.uid === value) ??
                datasources.find((ds) => ds.name === value),
        )
        .find((ds) => ds !== undefined);
    const found = picked ?? (ofType.length === 1 ? ofType[0] : undefined);
    if (found === undefined) return ref;
    if (isMultiValue(variable)) {
        warnings.push({
            code: 'variable-multi-value',
            message: `${what} reads the multi-value datasource variable ${name}; only ${found.name} is imported`,
        });
    }
    return {
        type: typeof ref === 'object' && ref?.type ? ref.type : found.type,
        uid: found.uid,
    };
};

/**
 * `SELECT * FROM name(args[, source])`, the args already SQL. With `series`, a series-shaped
 * result keeps its columns in order and names each series by that SQL expression instead.
 */
const tableFunctionSql = (
    name: string,
    args: string[],
    source: string | undefined,
    series?: string,
): string => {
    const allArgs =
        source === undefined || source === ''
            ? args
            : [...args, sqlStringLiteral(source)];
    const columns =
        series === undefined
            ? '*'
            : `"timestamp", "value", labels, ${series} AS series`;
    return `SELECT ${columns} FROM ${name}(${allArgs.join(', ')})`;
};

const translatePrometheusTarget = (
    target: GrafanaTarget,
    source: string | undefined,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
): TargetTranslation => {
    const expr = typeof target.expr === 'string' ? target.expr.trim() : '';
    if (expr === '') {
        warnings.push({
            code: 'query-empty',
            message: `Prometheus ${targetLabel(target)} has no expression`,
        });
        return {
            sql: null,
            todo: `TODO: Prometheus ${targetLabel(target)} has no expression to translate`,
            warnings,
        };
    }
    const query = queryExpressionSql(
        expr,
        `Prometheus ${targetLabel(target)}`,
        variables,
        warnings,
    );
    const series = legendSeriesSql(
        target,
        `Prometheus ${targetLabel(target)}`,
        variables,
        warnings,
    );
    if (target.instant === true && target.range !== true) {
        // promql_instant(query, time[, source]) evaluates at the end of the time range.
        return {
            sql: tableFunctionSql(
                'promql_instant',
                [query, TELEMETRY_SQL_TO],
                source,
                series,
            ),
            todo: null,
            warnings,
            shape: 'series',
        };
    }
    if (target.instant === true && target.range === true) {
        warnings.push({
            code: 'query-instant-dropped',
            message: `Prometheus ${targetLabel(target)} asks for both a range and an instant query; only the range query is imported`,
        });
    }
    return {
        sql: tableFunctionSql(
            'promql',
            [
                query,
                TELEMETRY_SQL_FROM,
                TELEMETRY_SQL_TO,
                TELEMETRY_SQL_INTERVAL,
            ],
            source,
            series,
        ),
        todo: null,
        warnings,
        shape: 'series',
    };
};

/**
 * A LogQL log query starts with a stream selector (`{job="api"} | json`); everything else
 * (`count_over_time(...)`, `rate(...)`, `sum by (...) (...)`, `topk(...)`) is a metric query.
 */
export const isLogqlLogQuery = (expr: string): boolean =>
    expr.trimStart().startsWith('{');

const lokiLimit = (
    target: GrafanaTarget,
    warnings: ImportWarning[],
): number => {
    const { maxLines } = target;
    if (maxLines === undefined || maxLines === null || maxLines === '') {
        return LOGQL_DEFAULT_LIMIT;
    }
    const limit = Number(maxLines);
    if (Number.isInteger(limit) && limit > 0) return limit;
    warnings.push({
        code: 'query-limit-invalid',
        message: `Loki ${targetLabel(target)} has maxLines ${String(maxLines)}, which is not a positive whole number; the default of ${LOGQL_DEFAULT_LIMIT} lines is used`,
    });
    return LOGQL_DEFAULT_LIMIT;
};

const lokiDirection = (
    target: GrafanaTarget,
    warnings: ImportWarning[],
): LogqlDirection => {
    const { direction } = target;
    if (direction === undefined || direction === null || direction === '') {
        return LOGQL_DEFAULT_DIRECTION;
    }
    if (direction === 'forward' || direction === 'backward') return direction;
    warnings.push({
        code: 'query-direction-unsupported',
        message: `Loki ${targetLabel(target)} has direction ${String(direction)}; the ${LOGQL_DEFAULT_DIRECTION} direction is used`,
    });
    return LOGQL_DEFAULT_DIRECTION;
};

const translateLokiTarget = (
    target: GrafanaTarget,
    source: string | undefined,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
): TargetTranslation => {
    const expr = typeof target.expr === 'string' ? target.expr.trim() : '';
    if (expr === '') {
        warnings.push({
            code: 'query-empty',
            message: `Loki ${targetLabel(target)} has no expression`,
        });
        return {
            sql: null,
            todo: `TODO: Loki ${targetLabel(target)} has no expression to translate`,
            warnings,
        };
    }
    const query = queryExpressionSql(
        expr,
        `Loki ${targetLabel(target)}`,
        variables,
        warnings,
    );
    if (isLogqlLogQuery(expr)) {
        return {
            sql: tableFunctionSql(
                'logql',
                [
                    query,
                    TELEMETRY_SQL_FROM,
                    TELEMETRY_SQL_TO,
                    String(lokiLimit(target, warnings)),
                    sqlStringLiteral(lokiDirection(target, warnings)),
                ],
                source,
            ),
            todo: null,
            warnings,
            shape: 'log-lines',
        };
    }
    // A legend names metric series; Grafana does not apply it to log lines.
    const series = legendSeriesSql(
        target,
        `Loki ${targetLabel(target)}`,
        variables,
        warnings,
    );
    if (target.queryType === 'instant' || target.instant === true) {
        // No instant LogQL function in CONTRACTS §1.1: a range query from __to to __to
        // yields the one value at the end of the time range.
        return {
            sql: tableFunctionSql(
                'logql_metric',
                [
                    query,
                    TELEMETRY_SQL_TO,
                    TELEMETRY_SQL_TO,
                    TELEMETRY_SQL_INTERVAL,
                ],
                source,
                series,
            ),
            todo: null,
            warnings,
            shape: 'series',
        };
    }
    return {
        sql: tableFunctionSql(
            'logql_metric',
            [
                query,
                TELEMETRY_SQL_FROM,
                TELEMETRY_SQL_TO,
                TELEMETRY_SQL_INTERVAL,
            ],
            source,
            series,
        ),
        todo: null,
        warnings,
        shape: 'series',
    };
};

/** The period a CloudWatch target without one (Grafana's `auto`) gets, in seconds. */
export const CLOUDWATCH_DEFAULT_PERIOD_SECONDS = 300;

/** The statistic a CloudWatch target without one gets (Grafana's default). */
export const CLOUDWATCH_DEFAULT_STATISTIC = 'Average';

const METRIC_DATA_QUERY_ID = /^[a-z][a-zA-Z0-9_]*$/;

/**
 * The MetricDataQuery `Id`: the target's `id` when CloudWatch accepts it, else one derived
 * from the refId (`A` → `a`, `B-2` → `b_2`), else `m1`.
 */
const cloudWatchQueryId = (target: GrafanaTarget): string => {
    if (typeof target.id === 'string' && METRIC_DATA_QUERY_ID.test(target.id)) {
        return target.id;
    }
    const refId =
        typeof target.refId === 'string'
            ? target.refId.replace(/[^A-Za-z0-9_]/g, '_')
            : '';
    const fromRefId = refId.charAt(0).toLowerCase() + refId.slice(1);
    return METRIC_DATA_QUERY_ID.test(fromRefId) ? fromRefId : 'm1';
};

/** A Grafana period (`60`, `'300'`, `'5m'`, `'1h'`) in seconds, or a warning and the default. */
const cloudWatchPeriod = (
    target: GrafanaTarget,
    warnings: ImportWarning[],
): number => {
    const { period } = target;
    const text = typeof period === 'number' ? String(period) : period;
    if (
        text === undefined ||
        text === null ||
        (typeof text === 'string' && ['', 'auto'].includes(text.trim()))
    ) {
        warnings.push({
            code: 'query-period-auto',
            message: `CloudWatch ${targetLabel(target)} has an automatic period; a fixed period of ${CLOUDWATCH_DEFAULT_PERIOD_SECONDS} seconds is used`,
        });
        return CLOUDWATCH_DEFAULT_PERIOD_SECONDS;
    }
    if (typeof text === 'string') {
        const trimmed = text.trim();
        if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
            return Number(trimmed);
        }
        try {
            const ms = parseTimeRangeDuration(trimmed);
            if (ms % 1000 === 0) return ms / 1000;
        } catch {
            // Reported below.
        }
    }
    warnings.push({
        code: 'query-period-invalid',
        message: `CloudWatch ${targetLabel(target)} has period ${String(period)}, which is not a number of seconds or a duration; ${CLOUDWATCH_DEFAULT_PERIOD_SECONDS} seconds is used`,
    });
    return CLOUDWATCH_DEFAULT_PERIOD_SECONDS;
};

/** The one statistic a MetricStat carries; further legacy `statistics` are reported. */
const cloudWatchStatistic = (
    target: GrafanaTarget,
    warnings: ImportWarning[],
): string => {
    const listed = Array.isArray(target.statistics)
        ? target.statistics.filter(
              (s): s is string => typeof s === 'string' && s.trim() !== '',
          )
        : [];
    const single =
        typeof target.statistic === 'string' && target.statistic.trim() !== ''
            ? target.statistic.trim()
            : undefined;
    const all = single !== undefined ? [single, ...listed] : listed;
    const unique = [...new Set(all.map((s) => s.trim()))];
    if (unique.length === 0) {
        warnings.push({
            code: 'query-statistic-missing',
            message: `CloudWatch ${targetLabel(target)} has no statistic; ${CLOUDWATCH_DEFAULT_STATISTIC} is used`,
        });
        return CLOUDWATCH_DEFAULT_STATISTIC;
    }
    if (unique.length > 1) {
        warnings.push({
            code: 'query-statistics-dropped',
            message: `CloudWatch ${targetLabel(target)} asks for several statistics (${unique.join(', ')}); only ${unique[0]} is imported, add a query for ${unique.slice(1).join(', ')} by hand`,
        });
    }
    return unique[0];
};

/**
 * The MetricStat dimensions, in the target's order. A `*` wildcard cannot be expressed in a
 * MetricStat and is left out; a list of values keeps its first value. Both are reported.
 */
const cloudWatchDimensions = (
    target: GrafanaTarget,
    warnings: ImportWarning[],
): CloudWatchDimension[] => {
    const { dimensions } = target;
    if (
        dimensions === null ||
        typeof dimensions !== 'object' ||
        Array.isArray(dimensions)
    ) {
        return [];
    }
    const result: CloudWatchDimension[] = [];
    Object.entries(dimensions as Record<string, unknown>).forEach(
        ([name, raw]) => {
            const values = (Array.isArray(raw) ? raw : [raw])
                .filter((v): v is string | number =>
                    ['string', 'number'].includes(typeof v),
                )
                .map((v) => String(v).trim())
                .filter((v) => v !== '');
            if (values.length === 0 || values.includes('*')) {
                warnings.push({
                    code: 'query-dimension-wildcard',
                    message: `CloudWatch ${targetLabel(target)} matches every value of dimension ${name} (*); a MetricStat cannot, so the dimension is left out and the query reads the metric without it`,
                });
                return;
            }
            if (values.length > 1) {
                warnings.push({
                    code: 'query-dimension-values-dropped',
                    message: `CloudWatch ${targetLabel(target)} matches several values of dimension ${name} (${values.join(', ')}); only ${values[0]} is imported`,
                });
            }
            result.push({ Name: name, Value: values[0] });
        },
    );
    return result;
};

/** CloudWatch dynamic labels (`${LABEL}`, `${MAX}`), which look like variables in a label. */
const CLOUDWATCH_DYNAMIC_LABELS: ReadonlySet<string> = new Set([
    'AVG',
    'DATAPOINT_COUNT',
    'FIRST',
    'FIRST_LAST_RANGE',
    'FIRST_LAST_TIME_RANGE',
    'FIRST_TIME',
    'FIRST_TIME_RELATIVE',
    'LABEL',
    'LAST',
    'LAST_TIME',
    'LAST_TIME_RELATIVE',
    'MAX',
    'MAX_MIN_RANGE',
    'MAX_MIN_TIME_RANGE',
    'MAX_TIME',
    'MAX_TIME_RELATIVE',
    'MIN',
    'MIN_TIME',
    'MIN_TIME_RELATIVE',
    'SUM',
    'TIME_RANGE',
]);

/**
 * The other targets of the panel a target is translated in, so CloudWatch metric math can read
 * the targets it references (hidden ones included).
 */
type PanelScope = {
    targets: GrafanaTarget[];
    /** Translates one of the panel's targets on its own (no panel scope). */
    translate: (target: GrafanaTarget) => TargetTranslation;
};

/** What a CloudWatch target in Metrics mode asks for. */
type CloudWatchMetricsKind =
    | { kind: 'metric-stat' }
    | { kind: 'expression'; expression: string; what: string }
    | { kind: 'unsupported' };

/**
 * A Metrics-mode target's kind, as Grafana's CloudWatch datasource reads it: Metrics Insights
 * (`metricQueryType` 1) sends its `sqlExpression`; Metric Search (`metricQueryType` 0 or unset)
 * in code mode (`metricEditorMode` 1) or with a non-empty `expression` sends the expression
 * (metric math, `SEARCH(...)`); otherwise it is a metric stat.
 */
const cloudWatchMetricsKind = (
    target: GrafanaTarget,
): CloudWatchMetricsKind => {
    const text = (value: unknown) =>
        typeof value === 'string' ? value.trim() : '';
    if (target.metricQueryType === 1) {
        return {
            kind: 'expression',
            expression: text(target.sqlExpression),
            what: 'Metrics Insights query',
        };
    }
    if (
        target.metricQueryType !== undefined &&
        target.metricQueryType !== null &&
        target.metricQueryType !== 0
    ) {
        return { kind: 'unsupported' };
    }
    const expression = text(target.expression);
    if (expression !== '' || target.metricEditorMode === 1) {
        return { kind: 'expression', expression, what: 'code-mode expression' };
    }
    return { kind: 'metric-stat' };
};

/** The target's `label` (or legacy `alias`), when it has one. */
const cloudWatchLabel = (target: GrafanaTarget): string | undefined =>
    [target.label, target.alias].find(
        (l): l is string => typeof l === 'string' && l.trim() !== '',
    );

/** `cloudwatch(<metric data query>, from, to[, source])` with the query's variables resolved. */
const cloudWatchSql = (
    target: GrafanaTarget,
    metricDataQuery: CloudWatchMetricDataQuery,
    source: string | undefined,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
): TargetTranslation => {
    // Compact JSON, so the query stays one readable line in the SQL (as buildTelemetrySql).
    const query = queryExpressionSql(
        JSON.stringify(metricDataQuery),
        `CloudWatch ${targetLabel(target)}`,
        variables,
        warnings,
        {
            escapeInline: (value) => JSON.stringify(value).slice(1, -1),
            nativeNames: CLOUDWATCH_DYNAMIC_LABELS,
        },
    );
    return {
        sql: tableFunctionSql(
            'cloudwatch',
            [query, TELEMETRY_SQL_FROM, TELEMETRY_SQL_TO],
            source,
        ),
        todo: null,
        warnings,
        shape: 'series',
    };
};

/** A token of CloudWatch metric math, as far as SQL can evaluate it. */
const MATH_TOKEN =
    /\s+|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()])|(.)/g;

type MathToken =
    | { kind: 'number' | 'operator'; text: string }
    | { kind: 'identifier'; text: string; call: boolean }
    | { kind: 'other'; text: string };

const mathTokens = (expression: string): MathToken[] => {
    const tokens: MathToken[] = [];
    for (const match of expression.matchAll(MATH_TOKEN)) {
        const [, num, identifier, operator, other] = match;
        if (num !== undefined) tokens.push({ kind: 'number', text: num });
        else if (operator !== undefined) {
            tokens.push({ kind: 'operator', text: operator });
        } else if (other !== undefined) {
            tokens.push({ kind: 'other', text: other });
        } else if (identifier !== undefined) {
            const rest = expression.slice(match.index + identifier.length);
            tokens.push({
                kind: 'identifier',
                text: identifier,
                call: /^\s*\(/.test(rest),
            });
        }
    }
    return tokens;
};

const quoteIdentifier = (name: string): string =>
    `"${name.replace(/"/g, '""')}"`;

/**
 * Metric math over other targets of the panel (`100 * errors / invocations`), or undefined
 * when the expression references none of them and goes to CloudWatch as it is.
 *
 * `cloudwatch()` carries one MetricDataQuery (CONTRACTS §1.1), so CloudWatch cannot evaluate
 * math over queries of the same request. Each referenced target (a metric stat, hidden or not)
 * becomes its own `cloudwatch()` call, joined on `timestamp`, and the arithmetic (numbers,
 * `+ - * /`, parentheses) is evaluated in SQL over their values. The result keeps the series
 * columns: the first input's `labels`, and the target's label (else its id) as `series`.
 * Functions (`METRICS()`, `SUM(...)`, `FILL(...)`), other operators and references to math
 * targets are a TODO with a `query-cloudwatch-math-unsupported` warning.
 */
const cloudWatchPanelMath = (
    target: GrafanaTarget,
    expression: string,
    panel: PanelScope,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
): TargetTranslation | undefined => {
    const others = new Map<string, GrafanaTarget>();
    panel.targets.forEach((t) => {
        if (t !== target) {
            const id = cloudWatchQueryId(t);
            if (!others.has(id)) others.set(id, t);
        }
    });
    const tokens = mathTokens(expression);
    const usesMetrics = tokens.some(
        (t) =>
            t.kind === 'identifier' &&
            t.call &&
            t.text.toUpperCase() === 'METRICS',
    );
    const references = tokens.filter(
        (t) => t.kind === 'identifier' && !t.call && others.has(t.text),
    );
    if (references.length === 0 && !usesMetrics) return undefined;
    const fail = (why: string): TargetTranslation => {
        warnings.push({
            code: 'query-cloudwatch-math-unsupported',
            message: `CloudWatch ${targetLabel(target)} computes ${expression} over other queries of the panel; ${why}, so it has no translation`,
        });
        return {
            sql: null,
            todo: `TODO: translate the CloudWatch metric math ${expression} (${targetLabel(target)}) by hand`,
            warnings,
        };
    };
    const unsupported = tokens.filter(
        (t) =>
            t.kind === 'other' ||
            (t.kind === 'identifier' && (t.call || !others.has(t.text))),
    );
    if (unsupported.length > 0) {
        return fail(
            `SQL evaluates only numbers, + - * / and references to the panel's metric queries, not ${[
                ...new Set(unsupported.map((t) => t.text)),
            ].join(', ')}`,
        );
    }
    let depth = 0;
    for (const t of tokens) {
        if (t.text === '(') depth += 1;
        if (t.text === ')') depth -= 1;
        if (depth < 0) break;
    }
    if (depth !== 0) return fail('its parentheses do not balance');
    const ids = [...new Set(references.map((t) => t.text))];
    const inputs: { id: string; sql: string; period: number }[] = [];
    for (const id of ids) {
        const input = others.get(id) as GrafanaTarget;
        const inputMode =
            typeof input.queryMode === 'string' ? input.queryMode : 'Metrics';
        if (
            inputMode !== 'Metrics' ||
            cloudWatchMetricsKind(input).kind !== 'metric-stat'
        ) {
            return fail(
                `${id} is not a metric stat, and only math over metric stats is evaluated in SQL`,
            );
        }
        const translated = panel.translate(input);
        // A visible input reports its own warnings as a query of the panel.
        if (input.hide === true) warnings.push(...translated.warnings);
        if (translated.sql === null || translated.shape !== 'series') {
            return fail(`its input ${id} does not translate`);
        }
        inputs.push({
            id,
            sql: translated.sql,
            period: cloudWatchPeriod(input, []),
        });
    }
    const periods = [...new Set(inputs.map((i) => i.period))];
    if (periods.length > 1) {
        warnings.push({
            code: 'query-cloudwatch-math-periods',
            message: `CloudWatch ${targetLabel(target)} computes ${expression} over inputs with different periods (${periods.join(', ')} seconds); only the timestamps they share have a value`,
        });
    }
    const value = tokens
        .map((t) =>
            t.kind === 'identifier'
                ? `${quoteIdentifier(t.text)}."value"`
                : t.text,
        )
        .join(' ');
    const findings = emptyFindings();
    const series = referencesSql(
        cloudWatchLabel(target) ?? cloudWatchQueryId(target),
        variables,
        { nativeNames: CLOUDWATCH_DYNAMIC_LABELS },
        findings,
    );
    pushReferenceWarnings(
        `The label of CloudWatch ${targetLabel(target)}`,
        findings,
        warnings,
    );
    const [first, ...rest] = inputs;
    const from = [
        `(${first.sql}) AS ${quoteIdentifier(first.id)}`,
        ...rest.map(
            (i) =>
                `JOIN (${i.sql}) AS ${quoteIdentifier(i.id)} ON ${quoteIdentifier(i.id)}."timestamp" = ${quoteIdentifier(first.id)}."timestamp"`,
        ),
    ].join('\n');
    return {
        sql: `SELECT ${quoteIdentifier(first.id)}."timestamp", ${value} AS "value", ${quoteIdentifier(first.id)}.labels, ${series} AS series\nFROM ${from}`,
        todo: null,
        warnings,
        shape: 'series',
    };
};

const translateCloudWatchTarget = (
    target: GrafanaTarget,
    source: string | undefined,
    variables: GrafanaTemplatingVariable[],
    warnings: ImportWarning[],
    panel?: PanelScope,
): TargetTranslation => {
    const queryMode =
        typeof target.queryMode === 'string' ? target.queryMode : 'Metrics';
    const metricsKind: CloudWatchMetricsKind =
        queryMode === 'Metrics'
            ? cloudWatchMetricsKind(target)
            : { kind: 'unsupported' };
    if (metricsKind.kind === 'unsupported') {
        warnings.push({
            code: 'query-cloudwatch-unsupported',
            message:
                queryMode === 'Metrics'
                    ? `CloudWatch ${targetLabel(target)} has metric query type ${String(target.metricQueryType)}, which has no translation yet`
                    : `CloudWatch ${targetLabel(target)} is a ${queryMode} query, which has no translation yet`,
        });
        return {
            sql: null,
            todo: `TODO: translate CloudWatch ${targetLabel(target)} by hand`,
            warnings,
        };
    }
    if (metricsKind.kind === 'expression' && metricsKind.expression === '') {
        warnings.push({
            code: 'query-empty',
            message: `CloudWatch ${targetLabel(target)} is a ${metricsKind.what} with no text`,
        });
        return {
            sql: null,
            todo: `TODO: CloudWatch ${targetLabel(target)} has no ${metricsKind.what} to translate`,
            warnings,
        };
    }
    if (metricsKind.kind === 'expression' && panel !== undefined) {
        const math = cloudWatchPanelMath(
            target,
            metricsKind.expression,
            panel,
            variables,
            warnings,
        );
        if (math !== undefined) return math;
    }
    const namespace =
        typeof target.namespace === 'string' ? target.namespace.trim() : '';
    const metricName =
        typeof target.metricName === 'string' ? target.metricName.trim() : '';
    if (
        metricsKind.kind === 'metric-stat' &&
        (namespace === '' || metricName === '')
    ) {
        warnings.push({
            code: 'query-empty',
            message: `CloudWatch ${targetLabel(target)} has no namespace or metric name`,
        });
        return {
            sql: null,
            todo: `TODO: CloudWatch ${targetLabel(target)} has no namespace or metric name to translate`,
            warnings,
        };
    }
    const region =
        typeof target.region === 'string' ? target.region.trim() : '';
    if (region !== '' && region !== 'default') {
        warnings.push({
            code: 'query-region-unsupported',
            message: `CloudWatch ${targetLabel(target)} reads region ${region}; the MetricDataQuery has no region, so the region of the Telemetry Source ${source ?? '(default)'} is used`,
        });
    }
    let metricDataQuery: CloudWatchMetricDataQuery;
    if (metricsKind.kind === 'expression') {
        // Metric math, SEARCH and Metrics Insights all go to CloudWatch as the Expression.
        metricDataQuery = {
            Id: cloudWatchQueryId(target),
            Expression: metricsKind.expression,
            Period: cloudWatchPeriod(target, warnings),
            ReturnData: true,
        };
    } else {
        const dimensions = cloudWatchDimensions(target, warnings);
        if (target.matchExact === false) {
            warnings.push({
                code: 'query-match-exact-dropped',
                message: `CloudWatch ${targetLabel(target)} also matches metrics with more dimensions than it lists (Match exact off); a MetricStat matches the listed dimensions exactly`,
            });
        }
        metricDataQuery = {
            Id: cloudWatchQueryId(target),
            MetricStat: {
                Metric: {
                    Namespace: namespace,
                    MetricName: metricName,
                    Dimensions: dimensions,
                },
                Period: cloudWatchPeriod(target, warnings),
                Stat: cloudWatchStatistic(target, warnings),
            },
            ReturnData: true,
        };
    }
    const label = cloudWatchLabel(target);
    if (label !== undefined) metricDataQuery.Label = label;
    return cloudWatchSql(target, metricDataQuery, source, variables, warnings);
};

/** The datasource types with a translation; anything else is `datasource-unsupported`. */
const TARGET_TRANSLATORS = new Map<
    string,
    (
        target: GrafanaTarget,
        source: string | undefined,
        variables: GrafanaTemplatingVariable[],
        warnings: ImportWarning[],
        panel?: PanelScope,
    ) => TargetTranslation
>([
    ['prometheus', translatePrometheusTarget],
    ['loki', translateLokiTarget],
    ['cloudwatch', translateCloudWatchTarget],
]);

const translateTarget = (
    target: GrafanaTarget,
    ctx: GrafanaQueryContext,
    panel?: PanelScope,
): TargetTranslation => {
    const warnings: ImportWarning[] = [];
    const ref = resolveDatasourceVariable(
        isUsableRef(target.datasource)
            ? target.datasource
            : ctx.panelDatasource,
        ctx,
        targetLabel(target),
        warnings,
    );
    const resolved = resolveDatasource(ref, ctx.datasources ?? []);
    if (resolved.type === undefined) {
        warnings.push({
            code: 'datasource-unresolved',
            message: `The datasource of ${targetLabel(target)} (${resolved.label}) could not be resolved`,
        });
        return {
            sql: null,
            todo: `TODO: ${targetLabel(target)} uses a datasource that could not be resolved (${resolved.label})`,
            warnings,
        };
    }
    const translator = TARGET_TRANSLATORS.get(resolved.type);
    if (translator === undefined) {
        warnings.push({
            code: 'datasource-unsupported',
            message: `${targetLabel(target)} uses the ${resolved.type} datasource, which has no translation`,
        });
        return {
            sql: null,
            todo: `TODO: translate ${targetLabel(target)} from the ${resolved.type} datasource by hand`,
            warnings,
        };
    }
    if (resolved.source === undefined) {
        warnings.push({
            code: 'datasource-unresolved',
            message: `The ${resolved.type} datasource ${resolved.label} of ${targetLabel(target)} is not a known Grafana datasource; the engine's default source is used`,
        });
    }
    return translator(
        target,
        resolved.source,
        ctx.variables ?? [],
        warnings,
        panel,
    );
};

/** Translates one Grafana target into SQL, or a TODO with warnings saying why not. */
export const translateGrafanaTarget = (
    target: GrafanaTarget,
    ctx: GrafanaQueryContext = {},
): GrafanaQueryTranslation => {
    const { sql, todo, warnings } = translateTarget(target, ctx);
    return { sql, todo, warnings };
};

/** One translated query per SELECT, combined into one result set. */
const unionAll = (queries: string[]): string =>
    queries.length === 1
        ? queries[0]
        : queries.map((sql) => `(${sql})`).join('\nUNION ALL\n');

/**
 * Translates a panel's targets into one chart's SQL. Hidden targets are skipped. The visible
 * targets that translate become one result set (UNION ALL); CloudWatch metric math evaluates
 * over the targets it references, hidden or not. A target whose result has other
 * columns than the first translated target's (log lines next to series) is left out with a
 * `panel-targets-not-combined` warning. Targets that don't translate are left out with their
 * warnings; when none translates, the panel is a TODO.
 */
export const translateGrafanaPanelQueries = (
    panel: GrafanaPanelWithTargets,
    ctx: GrafanaQueryContext = {},
): GrafanaQueryTranslation => {
    const targetCtx: GrafanaQueryContext = {
        ...ctx,
        panelDatasource: panel.datasource,
    };
    const visible = (panel.targets ?? []).filter((t) => t.hide !== true);
    if (visible.length === 0) {
        return {
            sql: null,
            todo: 'TODO: the panel has no visible query',
            warnings: [
                {
                    code: 'query-empty',
                    message: 'The panel has no visible query',
                },
            ],
        };
    }
    const warnings: ImportWarning[] = [];
    const todos: string[] = [];
    const queries: string[] = [];
    // Metric math reads the panel's other targets, hidden ones included.
    const panelScope: PanelScope = {
        targets: panel.targets ?? [],
        translate: (target) => translateTarget(target, targetCtx),
    };
    let shape: ResultShape | undefined;
    visible.forEach((target) => {
        const result = translateTarget(target, targetCtx, panelScope);
        warnings.push(...result.warnings);
        if (result.sql === null) {
            if (result.todo !== null) todos.push(result.todo);
            return;
        }
        if (queries.length === 0) {
            shape = result.shape;
            queries.push(result.sql);
        } else if (shape !== undefined && result.shape === shape) {
            queries.push(result.sql);
        } else {
            warnings.push({
                code: 'panel-targets-not-combined',
                message: `${targetLabel(target)} returns other columns than the panel's first query, so it cannot share the chart's result; add it as its own chart by hand`,
            });
        }
    });
    if (queries.length === 0) {
        return {
            sql: null,
            todo: todos.join('\n') || 'TODO: no query translated',
            warnings,
        };
    }
    return { sql: unionAll(queries), todo: null, warnings };
};
