/**
 * Shared argument handling and result shaping for the telemetry query tools (CONTRACTS §1.1).
 *
 * Every user value reaches the engine as a bind parameter; nothing here builds SQL text from input. Bad input is
 * refused with a `ToolInputError` before any engine connection is opened.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config, SourceKind } from '../config.js';
import { EngineError, type EngineResult } from '../engine/client.js';

/** A tool argument the engine must never see. Its message is shown to the caller and names no secret. */
export class ToolInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolInputError';
    }
}

/**
 * A Prometheus duration (`30s`, `5m`, `1h30m`, `250ms`): units in descending order, each at most once, and not zero.
 * The same grammar Prometheus itself accepts for `step`.
 */
const PROMETHEUS_DURATION = /^(?:\d+y)?(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?(?:\d+ms)?$/;

export function parseDuration(argument: string, value: string): string {
    if (value === '' || !PROMETHEUS_DURATION.test(value) || !/[1-9]/.test(value)) {
        throw new ToolInputError(
            `${argument} must be a positive Prometheus duration such as 30s, 5m, 1h or 1h30m`,
        );
    }
    return value;
}

/** ISO-8601: a date, or a date and time with `Z` or an offset (a time without a zone would depend on the host). */
const ISO_INSTANT =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?))?$/i;

/** Parses an ISO-8601 time argument into epoch ms, refusing impossible dates such as month 13 or 30 February. */
export function parseInstant(argument: string, value: string): number {
    const match = ISO_INSTANT.exec(value.trim());
    const ms = match ? Date.parse(value.trim()) : NaN;
    if (!match || Number.isNaN(ms)) {
        throw new ToolInputError(`${argument} must be an ISO-8601 time such as 2026-11-08T10:00:00Z`);
    }
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    const fieldsValid =
        date.getUTCFullYear() === Number(y) &&
        date.getUTCMonth() === Number(mo) - 1 &&
        date.getUTCDate() === Number(d) &&
        Number(h) < 24 &&
        Number(mi) < 60 &&
        Number(s) < 60;
    if (!fieldsValid) {
        throw new ToolInputError(`${argument} is not a valid date and time`);
    }
    return ms;
}

/** The ISO string sent to the engine for a time argument. */
export function isoParam(ms: number): string {
    return new Date(ms).toISOString();
}

/** `start` and `end` as engine parameters; `end` must not be before `start`. */
export function parseRange(start: string, end: string): { start: string; end: string } {
    const from = parseInstant('start', start);
    const to = parseInstant('end', end);
    if (to < from) throw new ToolInputError('end must not be before start');
    return { start: isoParam(from), end: isoParam(to) };
}

/**
 * The optional `source` argument: it must name a configured Telemetry Source of the tool's kind. Returns the bind
 * parameters to append (none when the caller gave no source, so the engine uses that kind's default).
 */
export function sourceParams(config: Pick<Config, 'sources'>, kind: SourceKind, source: string | undefined): string[] {
    if (source === undefined) return [];
    const match = config.sources.find((s) => s.name === source);
    if (!match || match.kind !== kind) {
        const names = config.sources.filter((s) => s.kind === kind).map((s) => s.name);
        throw new ToolInputError(
            `source must name a configured ${kind} Telemetry Source` +
                (names.length > 0 ? ` (one of: ${names.join(', ')})` : '; none is configured') +
                '. list_sources shows them all.',
        );
    }
    return [source];
}

/** `$1, $2, …` for `count` parameters. */
export function placeholders(count: number): string {
    return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
}

/** The `structuredContent` of every query tool. */
export interface TableResult {
    [key: string]: unknown;
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
}

/** JSON-safe cell values: timestamps become ISO strings; json columns arrive already parsed. */
function jsonCell(value: unknown): unknown {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    return value;
}

export function tableResult(result: EngineResult): TableResult {
    const rows = result.rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const column of result.columns) out[column] = jsonCell(row[column]);
        return out;
    });
    return { columns: [...result.columns], rows, rowCount: rows.length, truncated: false };
}

export function successResult(table: TableResult): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(table) }], structuredContent: table };
}

export function errorResult(text: string): CallToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
}

/** A tool error for a refused argument or a failed engine statement. Unexpected errors get a fixed sentence. */
export function failureResult(err: unknown, what: string): CallToolResult {
    if (err instanceof ToolInputError) return errorResult(err.message);
    if (err instanceof EngineError) {
        return errorResult(`${what} failed: ${err.message}${err.code ? ` (SQLSTATE ${err.code})` : ''}`);
    }
    return errorResult(`${what} failed: unexpected error`);
}
