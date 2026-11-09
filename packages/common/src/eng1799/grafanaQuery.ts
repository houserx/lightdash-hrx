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
    type LogqlDirection,
} from '../utils/telemetrySql';
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
): GrafanaQueryTranslation => {
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
): GrafanaQueryTranslation => {
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
        };
    }
    return {
        sql: buildTelemetrySql({ kind: 'logql_metric', query: expr, source }),
        todo: null,
        warnings,
    };
};

/** Translates one Grafana target into SQL, or a TODO with warnings saying why not. */
export const translateGrafanaTarget = (
    target: GrafanaTarget,
    ctx: GrafanaQueryContext = {},
): GrafanaQueryTranslation => {
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
    if (resolved.source === undefined) {
        warnings.push({
            code: 'datasource-unresolved',
            message: `The ${resolved.type} datasource ${resolved.label} of ${targetLabel(target)} is not a known Grafana datasource; the engine's default source is used`,
        });
    }
    switch (resolved.type) {
        case 'prometheus':
            return translatePrometheusTarget(target, resolved.source, warnings);
        case 'loki':
            return translateLokiTarget(target, resolved.source, warnings);
        default:
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
};

/**
 * Translates a panel's targets into one chart's SQL. Hidden targets are skipped. For now one
 * visible target becomes the chart; further targets are reported, not dropped silently.
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
    let sql: string | null = null;
    visible.forEach((target) => {
        const result = translateGrafanaTarget(target, targetCtx);
        warnings.push(...result.warnings);
        if (result.sql === null) {
            if (result.todo !== null) todos.push(result.todo);
        } else if (sql === null) {
            sql = result.sql;
        } else {
            warnings.push({
                code: 'panel-targets-not-combined',
                message: `${targetLabel(target)} is not combined with the panel's first query`,
            });
        }
    });
    return {
        sql,
        todo:
            sql === null
                ? todos.join('\n') || 'TODO: no query translated'
                : null,
        warnings,
    };
};
