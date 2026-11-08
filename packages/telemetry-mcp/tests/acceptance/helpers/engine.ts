/**
 * Fake Federation Engine for acceptance tests (CONTRACTS.md §1).
 *
 * - A real Postgres wire protocol v3 server (simple + extended query protocol, cleartext password
 *   login) on 127.0.0.1, ephemeral port. It records every statement with its bound parameters and
 *   the session `SET`s in force when it ran, so tests can assert that `SET hrx.identity` was sent
 *   first and that user input travelled only as parameters.
 * - A fake HTTP side port (§1.3) serving `POST /v1/write` and `GET /v1/audit`, recording requests.
 *
 * Node built-ins only. PROTECTED: later sessions must not edit this file.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export type PgType = 'text' | 'float8' | 'int8' | 'int4' | 'timestamptz' | 'bool' | 'json';

const TYPE_INFO: Record<PgType, { oid: number; len: number }> = {
    text: { oid: 25, len: -1 },
    float8: { oid: 701, len: 8 },
    int8: { oid: 20, len: 8 },
    int4: { oid: 23, len: 4 },
    timestamptz: { oid: 1184, len: 8 },
    bool: { oid: 16, len: 1 },
    json: { oid: 114, len: -1 },
};

export interface EngineQuery {
    sql: string;
    params: (string | null)[];
    protocol: 'simple' | 'extended';
    connectionId: number;
    /** Session SETs in force when this statement ran (keys lower-cased, values unquoted). */
    sets: Record<string, string>;
    user: string;
    database: string;
}

export type EngineResult =
    | { columns: { name: string; type: PgType }[]; rows: unknown[][] }
    | { error: { code: string; message: string } }
    | { command: string };

export type EngineHandler = (q: EngineQuery) => EngineResult | undefined;

export interface HttpRecord {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: http.IncomingHttpHeaders;
    body: unknown;
}

export type HttpHandler = (req: HttpRecord) => { status: number; body: unknown } | undefined;

export interface FakeEngine {
    pgHost: string;
    pgPort: number;
    pgUser: string;
    pgPassword: string;
    pgDatabase: string;
    httpUrl: string;
    /** Every statement received, in order (SETs included). */
    queries: EngineQuery[];
    /** Statements other than SET/RESET/BEGIN/COMMIT/ROLLBACK/DISCARD. */
    dataQueries(): EngineQuery[];
    /** Every HTTP request received on the side port. */
    httpRequests: HttpRecord[];
    connectionCount(): number;
    /** Client connections currently open. */
    openConnections(): number;
    /** Handlers are tried newest first; the first non-undefined result wins. */
    on(match: RegExp | ((q: EngineQuery) => boolean), result: EngineResult | EngineHandler): void;
    onHttp(method: string, path: string, handler: HttpHandler | { status: number; body: unknown }): void;
    close(): Promise<void>;
}

const SESSION_COMMAND = /^\s*(SET|RESET|BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|DISCARD)\b/i;

function cstr(s: string): Buffer {
    return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

function int16(n: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
}

function int32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
}

function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
    return Buffer.concat([Buffer.from(type, 'ascii'), int32(body.length + 4), body]);
}

function encodeValue(v: unknown, type: PgType): Buffer | null {
    if (v === null || v === undefined) return null;
    if (type === 'timestamptz') {
        const d = v instanceof Date ? v : new Date(String(v));
        return Buffer.from(d.toISOString().replace('T', ' ').replace('Z', '+00'), 'utf8');
    }
    if (type === 'bool') return Buffer.from(v ? 't' : 'f', 'utf8');
    if (type === 'json') return Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
    return Buffer.from(String(v), 'utf8');
}

function errorResponse(code: string, msg: string): Buffer {
    return message(
        'E',
        Buffer.concat([
            Buffer.from('S'),
            cstr('ERROR'),
            Buffer.from('V'),
            cstr('ERROR'),
            Buffer.from('C'),
            cstr(code),
            Buffer.from('M'),
            cstr(msg),
            Buffer.from([0]),
        ]),
    );
}

/** Splits a simple-protocol query string on top-level semicolons (single quotes respected). */
function splitStatements(sql: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i] as string;
        if (ch === "'") inQuote = !inQuote;
        if (ch === ';' && !inQuote) {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function parseSet(sql: string): [string, string] | null {
    const m = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?([A-Za-z_][\w.]*)\s*(?:=|\s+TO\s+)\s*([\s\S]*?)\s*;?\s*$/i.exec(
        sql,
    );
    if (!m) return null;
    let value = (m[2] ?? '').trim();
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        value = value.slice(1, -1).replace(/''/g, "'");
    }
    return [(m[1] ?? '').toLowerCase(), value];
}

interface Portal {
    sql: string;
    params: (string | null)[];
    result?: EngineResult;
    offset: number;
}

export async function startFakeEngine(
    opts: { user?: string; password?: string; database?: string } = {},
): Promise<FakeEngine> {
    const pgUser = opts.user ?? 'lightdash-operations';
    const pgPassword = opts.password ?? 'test-pg-password-not-real';
    const pgDatabase = opts.database ?? 'operations';
    const queries: EngineQuery[] = [];
    const handlers: { match: (q: EngineQuery) => boolean; result: EngineResult | EngineHandler }[] = [];
    const httpRequests: HttpRecord[] = [];
    const httpHandlers: { method: string; path: string; handler: HttpHandler }[] = [];
    let connections = 0;
    const sockets = new Set<net.Socket>();

    function resolve(q: EngineQuery): EngineResult {
        const set = parseSet(q.sql);
        if (set) return { command: 'SET' };
        if (SESSION_COMMAND.test(q.sql)) {
            return { command: (q.sql.trim().split(/\s+/)[0] ?? 'OK').toUpperCase() };
        }
        for (let i = handlers.length - 1; i >= 0; i -= 1) {
            const h = handlers[i]!;
            if (!h.match(q)) continue;
            const r = typeof h.result === 'function' ? h.result(q) : h.result;
            if (r !== undefined) return r;
        }
        return { error: { code: 'XX000', message: `fake engine: no handler for statement` } };
    }

    function rowDescription(columns: { name: string; type: PgType }[]): Buffer {
        return message(
            'T',
            Buffer.concat([
                int16(columns.length),
                ...columns.map((c) =>
                    Buffer.concat([
                        cstr(c.name),
                        int32(0),
                        int16(0),
                        int32(TYPE_INFO[c.type].oid),
                        int16(TYPE_INFO[c.type].len),
                        int32(-1),
                        int16(0),
                    ]),
                ),
            ]),
        );
    }

    function dataRow(columns: { name: string; type: PgType }[], row: unknown[]): Buffer {
        const parts: Buffer[] = [int16(columns.length)];
        columns.forEach((c, i) => {
            const v = encodeValue(row[i], c.type);
            if (v === null) parts.push(int32(-1));
            else parts.push(int32(v.length), v);
        });
        return message('D', Buffer.concat(parts));
    }

    const pgServer = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        connections += 1;
        const connectionId = connections;
        const sets: Record<string, string> = {};
        let user = '';
        let database = '';
        let buf = Buffer.alloc(0);
        let phase: 'startup' | 'password' | 'ready' = 'startup';
        let inError = false;
        const statements = new Map<string, string>();
        const portals = new Map<string, Portal>();

        const send = (b: Buffer): void => {
            if (!socket.destroyed) socket.write(b);
        };

        const record = (sql: string, params: (string | null)[], protocol: 'simple' | 'extended'): EngineResult => {
            const set = parseSet(sql);
            if (set) sets[set[0]] = set[1];
            const q: EngineQuery = {
                sql,
                params,
                protocol,
                connectionId,
                sets: { ...sets },
                user,
                database,
            };
            queries.push(q);
            return resolve(q);
        };

        const sendResult = (r: EngineResult, withDescription: boolean): void => {
            if ('error' in r) {
                send(errorResponse(r.error.code, r.error.message));
                return;
            }
            if ('command' in r) {
                send(message('C', cstr(r.command)));
                return;
            }
            if (withDescription) send(rowDescription(r.columns));
            for (const row of r.rows) send(dataRow(r.columns, row));
            send(message('C', cstr(`SELECT ${r.rows.length}`)));
        };

        const handleStartup = (body: Buffer): void => {
            const code = body.readInt32BE(0);
            if (code === 80877103 || code === 80877104) {
                send(Buffer.from('N'));
                return;
            }
            if (code === 80877102) {
                socket.end();
                return;
            }
            const params: Record<string, string> = {};
            const fields = body.subarray(4).toString('utf8').split('\0');
            for (let i = 0; i + 1 < fields.length; i += 2) {
                if (fields[i]) params[fields[i] as string] = fields[i + 1] ?? '';
            }
            user = params.user ?? '';
            database = params.database ?? user;
            phase = 'password';
            send(message('R', int32(3)));
        };

        const handlePassword = (body: Buffer): void => {
            const password = body.toString('utf8').replace(/\0+$/, '');
            if (user !== pgUser || password !== pgPassword) {
                send(errorResponse('28P01', `password authentication failed for user "${user}"`));
                socket.end();
                return;
            }
            phase = 'ready';
            send(message('R', int32(0)));
            for (const [k, v] of [
                ['server_version', '16.0'],
                ['client_encoding', 'UTF8'],
                ['DateStyle', 'ISO, MDY'],
                ['integer_datetimes', 'on'],
                ['standard_conforming_strings', 'on'],
                ['TimeZone', 'UTC'],
            ] as const) {
                send(message('S', Buffer.concat([cstr(k), cstr(v)])));
            }
            send(message('K', Buffer.concat([int32(connectionId), int32(424242)])));
            send(message('Z', Buffer.from('I')));
        };

        const readCStr = (b: Buffer, offset: number): [string, number] => {
            const end = b.indexOf(0, offset);
            return [b.subarray(offset, end).toString('utf8'), end + 1];
        };

        const handleMessage = (type: string, body: Buffer): void => {
            if (type === 'X') {
                socket.end();
                return;
            }
            if (type === 'S') {
                inError = false;
                send(message('Z', Buffer.from('I')));
                return;
            }
            if (type === 'Q') {
                const sql = body.toString('utf8').replace(/\0+$/, '');
                const parts = splitStatements(sql);
                if (parts.length === 0) send(message('I'));
                for (const part of parts) {
                    const r = record(part, [], 'simple');
                    sendResult(r, true);
                    if ('error' in r) break;
                }
                send(message('Z', Buffer.from('I')));
                return;
            }
            if (inError) return;
            if (type === 'P') {
                const [name, o1] = readCStr(body, 0);
                const [sql] = readCStr(body, o1);
                statements.set(name, sql);
                send(message('1'));
                return;
            }
            if (type === 'B') {
                let o = 0;
                let portal: string;
                let stmt: string;
                [portal, o] = readCStr(body, o);
                [stmt, o] = readCStr(body, o);
                const nFormats = body.readInt16BE(o);
                o += 2;
                const formats: number[] = [];
                for (let i = 0; i < nFormats; i += 1) {
                    formats.push(body.readInt16BE(o));
                    o += 2;
                }
                const nParams = body.readInt16BE(o);
                o += 2;
                const params: (string | null)[] = [];
                for (let i = 0; i < nParams; i += 1) {
                    const len = body.readInt32BE(o);
                    o += 4;
                    if (len === -1) params.push(null);
                    else {
                        const raw = body.subarray(o, o + len);
                        const fmt = nFormats === 1 ? formats[0] : formats[i];
                        params.push(fmt === 1 ? `\\x${raw.toString('hex')}` : raw.toString('utf8'));
                        o += len;
                    }
                }
                portals.set(portal, { sql: statements.get(stmt) ?? '', params, offset: 0 });
                send(message('2'));
                return;
            }
            if (type === 'D') {
                const kind = String.fromCharCode(body[0] as number);
                const [name] = readCStr(body, 1);
                if (kind === 'S') {
                    send(message('t', int16(0)));
                    send(message('n'));
                    return;
                }
                const p = portals.get(name);
                if (!p) {
                    send(errorResponse('34000', 'portal does not exist'));
                    inError = true;
                    return;
                }
                p.result ??= record(p.sql, p.params, 'extended');
                const r = p.result;
                if ('error' in r) {
                    send(errorResponse(r.error.code, r.error.message));
                    inError = true;
                } else if ('command' in r) send(message('n'));
                else send(rowDescription(r.columns));
                return;
            }
            if (type === 'E') {
                const [name, o1] = readCStr(body, 0);
                const maxRows = body.readInt32BE(o1);
                const p = portals.get(name);
                if (!p) {
                    send(errorResponse('34000', 'portal does not exist'));
                    inError = true;
                    return;
                }
                p.result ??= record(p.sql, p.params, 'extended');
                const r = p.result;
                if ('error' in r) {
                    send(errorResponse(r.error.code, r.error.message));
                    inError = true;
                    return;
                }
                if ('command' in r) {
                    send(message('C', cstr(r.command)));
                    return;
                }
                const remaining = r.rows.slice(p.offset);
                if (maxRows > 0 && remaining.length > maxRows) {
                    for (const row of remaining.slice(0, maxRows)) send(dataRow(r.columns, row));
                    p.offset += maxRows;
                    send(message('s'));
                    return;
                }
                for (const row of remaining) send(dataRow(r.columns, row));
                p.offset = r.rows.length;
                send(message('C', cstr(`SELECT ${r.rows.length}`)));
                return;
            }
            if (type === 'C') {
                send(message('3'));
                return;
            }
            // 'H' (Flush) and anything else: no response.
        };

        socket.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
                if (phase === 'startup') {
                    if (buf.length < 4) return;
                    const len = buf.readInt32BE(0);
                    if (buf.length < len) return;
                    const body = buf.subarray(4, len);
                    buf = buf.subarray(len);
                    handleStartup(body);
                    continue;
                }
                if (buf.length < 5) return;
                const type = String.fromCharCode(buf[0] as number);
                const len = buf.readInt32BE(1);
                if (buf.length < len + 1) return;
                const body = buf.subarray(5, len + 1);
                buf = buf.subarray(len + 1);
                if (phase === 'password') {
                    if (type === 'p') handlePassword(body);
                    else socket.end();
                    continue;
                }
                handleMessage(type, body);
            }
        });
    });

    const httpServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: unknown = raw;
            try {
                body = raw ? JSON.parse(raw) : null;
            } catch {
                // keep raw text
            }
            const rec: HttpRecord = {
                method: req.method ?? 'GET',
                path: url.pathname,
                query: Object.fromEntries(url.searchParams.entries()),
                headers: req.headers,
                body,
            };
            httpRequests.push(rec);
            let out: { status: number; body: unknown } | undefined;
            for (let i = httpHandlers.length - 1; i >= 0 && !out; i -= 1) {
                const h = httpHandlers[i]!;
                if (h.method === rec.method && h.path === rec.path) out = h.handler(rec);
            }
            out ??= { status: 404, body: { error: 'fake engine: no handler' } };
            res.writeHead(out.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body));
        });
    });

    await new Promise<void>((r) => pgServer.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const pgPort = (pgServer.address() as AddressInfo).port;
    const httpPort = (httpServer.address() as AddressInfo).port;

    return {
        pgHost: '127.0.0.1',
        pgPort,
        pgUser,
        pgPassword,
        pgDatabase,
        httpUrl: `http://127.0.0.1:${httpPort}`,
        queries,
        dataQueries: () => queries.filter((q) => !SESSION_COMMAND.test(q.sql)),
        httpRequests,
        connectionCount: () => connections,
        openConnections: () => sockets.size,
        on(match, result) {
            const fn = match instanceof RegExp ? (q: EngineQuery) => match.test(q.sql) : match;
            handlers.push({ match: fn, result });
        },
        onHttp(method, path, handler) {
            httpHandlers.push({
                method,
                path,
                handler: typeof handler === 'function' ? handler : () => handler,
            });
        },
        async close() {
            for (const s of sockets) s.destroy();
            httpServer.closeAllConnections?.();
            await Promise.all([
                new Promise<void>((r) => pgServer.close(() => r())),
                new Promise<void>((r) => httpServer.close(() => r())),
            ]);
        },
    };
}
