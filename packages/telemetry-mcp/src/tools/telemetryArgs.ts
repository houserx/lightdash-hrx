/**
 * Shared argument handling and result shaping for the telemetry query tools (CONTRACTS §1.1).
 *
 * Every user value reaches the engine as a bind parameter; nothing here builds SQL text from input. Bad input is
 * refused with a `ToolInputError` before any engine connection is opened.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config, SourceKind } from '../config.js';
import { EngineError, type EngineResult } from '../engine/client.js';
import { engineErrorText } from '../engine/errors.js';

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

/** `now`, or `now-<Prometheus duration>` such as `now-1h`, `now-2d` or `now-1h30m`. */
const RELATIVE_INSTANT = /^now(?:-(.+))?$/i;

const DURATION_UNIT_MS: Record<string, number> = {
    y: 365 * 86_400_000,
    w: 7 * 86_400_000,
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
    ms: 1,
};

/** Milliseconds in a duration already accepted by `parseDuration` (a year is 365 days, as in Prometheus). */
export function durationMs(duration: string): number {
    let total = 0;
    for (const [, amount, unit] of duration.matchAll(/(\d+)(ms|y|w|d|h|m|s)/g)) {
        total += Number(amount) * DURATION_UNIT_MS[unit];
    }
    return total;
}

const TIME_FORMAT_HINT = 'an ISO-8601 time such as 2026-11-08T10:00:00Z, or now or now-<duration> such as now-1h';

/**
 * Parses a time argument into epoch ms: `now` and `now-<duration>` are resolved against the server clock `now`;
 * anything else must be ISO-8601. Impossible dates such as month 13 or 30 February are refused.
 */
export function parseInstant(argument: string, value: string, now: number): number {
    const trimmed = value.trim();
    const relative = RELATIVE_INSTANT.exec(trimmed);
    if (relative) {
        if (relative[1] === undefined) return now;
        const duration = relative[1];
        if (duration === '' || !PROMETHEUS_DURATION.test(duration) || !/[1-9]/.test(duration)) {
            throw new ToolInputError(`${argument} must be ${TIME_FORMAT_HINT}`);
        }
        return now - durationMs(duration);
    }
    const match = ISO_INSTANT.exec(trimmed);
    const ms = match ? Date.parse(trimmed) : NaN;
    if (!match || Number.isNaN(ms)) {
        throw new ToolInputError(`${argument} must be ${TIME_FORMAT_HINT}`);
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

/** `start` and `end` as engine parameters, resolved against the server clock `now`; `end` must not be before `start`. */
export function parseRange(start: string, end: string, now: number): { start: string; end: string } {
    const from = parseInstant('start', start, now);
    const to = parseInstant('end', end, now);
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

/**
 * The `structuredContent` of every query tool. `rows` holds at most `MCP_MAX_ROWS` rows; `truncated` says the engine
 * had more, and `rowCount` is the number of rows returned.
 */
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
    return { columns: [...result.columns], rows, rowCount: rows.length, truncated: result.truncated };
}

export function successResult(table: TableResult): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(table) }], structuredContent: table };
}

export function errorResult(text: string): CallToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * A tool error for a refused argument or a failed engine statement (SQLSTATEs mapped by `engineErrorText`). It never
 * carries rows. Unexpected errors get a fixed sentence.
 */
export function failureResult(err: unknown, what: string): CallToolResult {
    if (err instanceof ToolInputError) return errorResult(err.message);
    if (err instanceof EngineError) return errorResult(engineErrorText(err, what));
    return errorResult(`${what} failed: unexpected error`);
}
