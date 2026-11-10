/* eslint-disable */
// @ts-nocheck
// Helpers for the transformation acceptance tests (protected).
import { panel } from './support';

export const PG_DS = { type: 'grafana-postgresql-datasource', uid: 'pg-platform' };

/** A Postgres-backed panel, so the result columns are known by name. */
export const pgPanel = (
    title: string,
    y: number,
    rawSql: string | string[],
    transformations: object[],
    type = 'table',
) =>
    panel(type, title, { x: 0, y, w: 24, h: 8 }, {
        datasource: PG_DS,
        targets: (Array.isArray(rawSql) ? rawSql : [rawSql]).map((sql, i) => ({
            refId: String.fromCharCode(65 + i),
            datasource: PG_DS,
            editorMode: 'code',
            format: 'table',
            rawQuery: true,
            rawSql: sql,
        })),
        transformations,
    });

/** Warnings in the report on lines that name this panel. */
export const reportLinesFor = (report: string, title: string) =>
    report
        .split('\n')
        .filter((line) => line.includes(title))
        .join('\n');
