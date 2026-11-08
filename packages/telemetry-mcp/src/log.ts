/**
 * Structured logs: one JSON object per line, `{ time, level, msg, ...fields }`.
 *
 * Log lines are metadata only. Callers pass fixed messages and small scalar fields (a tool name, an outcome, a
 * duration, a count, a reason code); they never pass query results, SQL or other query text, tool arguments, error
 * messages from the engine, tokens or secrets. As a second line of defence every string that reaches a line has each
 * configured secret and every token-shaped string (JWT, identity token) replaced by `[redacted]`, and is cut to
 * `MAX_LOG_STRING_LENGTH`. Objects and arrays are not accepted as field values, so a result set cannot slip in whole.
 */
import { redactSecrets } from './engine/errors.js';
import { LOG_LEVELS, type LogLevel } from './config.js';

/** A string field longer than this is cut. */
export const MAX_LOG_STRING_LENGTH = 200;

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface Logger {
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
}

/** Names the line itself owns; a field with one of these names is dropped. */
const RESERVED = new Set(['time', 'level', 'msg']);

export interface LoggerOptions {
    /** Lines below this level are dropped. */
    level: LogLevel;
    /** Where each finished line goes (no trailing newline). Default: stdout. */
    write?: (line: string) => void;
    /** Values that must never appear in a line, such as `HRX_IDENTITY_SECRET`. */
    secrets?: readonly (string | undefined)[];
    /** Clock for `time`, epoch ms. Default: `Date.now`. */
    now?: () => number;
}

function writeStdout(line: string): void {
    process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
    const write = options.write ?? writeStdout;
    const secrets = options.secrets ?? [];
    const now = options.now ?? Date.now;
    const threshold = LOG_LEVELS.indexOf(options.level);
    const clean = (s: string): string => {
        const out = redactSecrets(s, secrets);
        return out.length > MAX_LOG_STRING_LENGTH ? `${out.slice(0, MAX_LOG_STRING_LENGTH)}…` : out;
    };
    const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
        if (LOG_LEVELS.indexOf(level) < threshold) return;
        const line: Record<string, string | number | boolean | null> = {
            time: new Date(now()).toISOString(),
            level,
            msg: clean(msg),
        };
        for (const [key, value] of Object.entries(fields)) {
            if (RESERVED.has(key) || value === undefined) continue;
            if (typeof value === 'string') line[key] = clean(value);
            else if (typeof value === 'number') line[key] = Number.isFinite(value) ? value : null;
            else if (typeof value === 'boolean' || value === null) line[key] = value;
            // Anything else (an object smuggled past the types) is dropped, never serialized.
        }
        try {
            write(JSON.stringify(line));
        } catch {
            // Logging must never break a request.
        }
    };
    return {
        debug: (msg, fields) => emit('debug', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        error: (msg, fields) => emit('error', msg, fields),
    };
}

/** The configured secrets a log line must never contain. */
export function configSecrets(config: {
    identitySecret: string;
    lightdash: { apiToken: string };
    engine: { pgPassword: string };
    anthropicApiKey: string | undefined;
}): (string | undefined)[] {
    return [config.identitySecret, config.lightdash.apiToken, config.engine.pgPassword, config.anthropicApiKey];
}
