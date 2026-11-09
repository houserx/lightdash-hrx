/**
 * ENG-1799 importers: turns Grafana panel targets into Lightdash SQL over the engine's table
 * functions (CONTRACTS §1.1), with time arguments taken from the reserved parameters
 * (CONTRACTS §2) so every chart follows the Dashboard Time Range.
 *
 * Pure: no network, no filesystem, no Lightdash API. Anything that does not translate is a
 * TODO plus a structured warning, never a silent drop.
 */
import {
    buildTelemetrySql,
    LOGQL_DEFAULT_DIRECTION,
    LOGQL_DEFAULT_LIMIT,
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
    if (typeof ref === 'string') return ref.trim() !== '';
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
    const found =
        ref.uid === undefined
            ? undefined
            : datasources.find((ds) => ds.uid === ref.uid);
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

const translatePrometheusTarget = (
    target: GrafanaTarget,
    source: string | undefined,
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
    if (target.instant === true && target.range !== true) {
        // promql_instant(query, time[, source]) evaluates at the end of the time range.
        const args = [sqlStringLiteral(expr), TELEMETRY_SQL_TO];
        if (source !== undefined) args.push(sqlStringLiteral(source));
        return {
            sql: `SELECT * FROM promql_instant(${args.join(', ')})`,
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
        sql: buildTelemetrySql({ kind: 'promql', query: expr, source }),
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
    if (isLogqlLogQuery(expr)) {
        return {
            sql: buildTelemetrySql({
                kind: 'logql',
                query: expr,
                limit: lokiLimit(target, warnings),
                direction: lokiDirection(target, warnings),
                source,
            }),
            todo: null,
            warnings,
            shape: 'log-lines',
        };
    }
    if (target.queryType === 'instant' || target.instant === true) {
        // No instant LogQL function in CONTRACTS §1.1: a range query from __to to __to
        // yields the one value at the end of the time range.
        const args = [
            sqlStringLiteral(expr),
            TELEMETRY_SQL_TO,
            TELEMETRY_SQL_TO,
            TELEMETRY_SQL_INTERVAL,
        ];
        if (source !== undefined) args.push(sqlStringLiteral(source));
        return {
            sql: `SELECT * FROM logql_metric(${args.join(', ')})`,
            todo: null,
            warnings,
            shape: 'series',
        };
    }
    return {
        sql: buildTelemetrySql({ kind: 'logql_metric', query: expr, source }),
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

const translateCloudWatchTarget = (
    target: GrafanaTarget,
    source: string | undefined,
    warnings: ImportWarning[],
): TargetTranslation => {
    const queryMode =
        typeof target.queryMode === 'string' ? target.queryMode : 'Metrics';
    const expression =
        typeof target.expression === 'string' ? target.expression.trim() : '';
    const isMetricStat =
        queryMode === 'Metrics' &&
        (target.metricQueryType === undefined ||
            target.metricQueryType === 0) &&
        expression === '';
    if (!isMetricStat) {
        warnings.push({
            code: 'query-cloudwatch-unsupported',
            message: `CloudWatch ${targetLabel(target)} is a ${queryMode === 'Metrics' ? 'metric math, code or Metrics Insights' : queryMode} query, which has no translation yet`,
        });
        return {
            sql: null,
            todo: `TODO: translate CloudWatch ${targetLabel(target)} by hand`,
            warnings,
        };
    }
    const namespace =
        typeof target.namespace === 'string' ? target.namespace.trim() : '';
    const metricName =
        typeof target.metricName === 'string' ? target.metricName.trim() : '';
    if (namespace === '' || metricName === '') {
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
    const dimensions = cloudWatchDimensions(target, warnings);
    if (target.matchExact === false) {
        warnings.push({
            code: 'query-match-exact-dropped',
            message: `CloudWatch ${targetLabel(target)} also matches metrics with more dimensions than it lists (Match exact off); a MetricStat matches the listed dimensions exactly`,
        });
    }
    const metricDataQuery: CloudWatchMetricDataQuery = {
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
    const label = [target.label, target.alias].find(
        (l): l is string => typeof l === 'string' && l.trim() !== '',
    );
    if (label !== undefined) metricDataQuery.Label = label;
    return {
        sql: buildTelemetrySql({ kind: 'cloudwatch', metricDataQuery, source }),
        todo: null,
        warnings,
        shape: 'series',
    };
};

/** The datasource types with a translation; anything else is `datasource-unsupported`. */
const TARGET_TRANSLATORS = new Map<
    string,
    (
        target: GrafanaTarget,
        source: string | undefined,
        warnings: ImportWarning[],
    ) => TargetTranslation
>([
    ['prometheus', translatePrometheusTarget],
    ['loki', translateLokiTarget],
    ['cloudwatch', translateCloudWatchTarget],
]);

const translateTarget = (
    target: GrafanaTarget,
    ctx: GrafanaQueryContext,
): TargetTranslation => {
    const warnings: ImportWarning[] = [];
    const ref = isUsableRef(target.datasource)
        ? target.datasource
        : ctx.panelDatasource;
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
    return translator(target, resolved.source, warnings);
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
 * targets that translate become one result set (UNION ALL); a target whose result has other
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
    let shape: ResultShape | undefined;
    visible.forEach((target) => {
        const result = translateTarget(target, targetCtx);
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
