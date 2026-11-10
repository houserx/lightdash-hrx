/* eslint-disable */
// @ts-nocheck
// Shared helpers for the importers acceptance tests (protected). Loosely typed on purpose: they
// drive modules that later sessions build.
//
// The tests never compare generated SQL character for character. They do what the Lightdash
// query path and the Federation Engine do: substitute `${ld.parameters.<name>}` with a quoted SQL
// string literal (as `safeReplaceParameters` does for string parameters), constant-fold
// `'a' || 'b'` concatenations (as the engine does with table-function arguments, CONTRACTS §1.1),
// and then read the arguments of the table-function calls.

/** Loads a module through a non-literal specifier so this folder typechecks before it exists. */
export const load = async (specifier: string): Promise<any> =>
    import(/* @vite-ignore */ specifier);

/** The query module the goal names: packages/common/src/eng1799/grafanaQuery.ts. */
export const loadGrafanaQuery = () => load('../../eng1799/grafanaQuery');

/** Values used for the CONTRACTS §2 reserved parameters when a test folds SQL. */
export const RESERVED = {
    __from: '2026-01-01T00:00:00Z',
    __to: '2026-01-01T06:00:00Z',
    __interval: '1m',
    __range: '6h',
};

const quote = (value: unknown) => `'${String(value).replace(/'/g, "''")}'`;

/** Every `${ld.parameters.<name>}` reference in the SQL, in order. */
export const parameterRefs = (sql: string): string[] =>
    [...sql.matchAll(/\$\{ld\.parameters\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);

/** Replaces parameter references with quoted literals; unknown names throw. */
export const substitute = (
    sql: string,
    params: Record<string, unknown> = {},
): string =>
    sql.replace(/\$\{ld\.parameters\.([A-Za-z0-9_]+)\}/g, (_m, name) => {
        const all = { ...RESERVED, ...params };
        if (!(name in all)) {
            throw new Error(`SQL references unknown parameter ${name}: ${sql}`);
        }
        return quote(all[name]);
    });

type Tok = { t: 'str' | 'op' | 'punct' | 'word'; v: string };

export const tokenize = (sql: string): Tok[] => {
    const toks: Tok[] = [];
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (/\s/.test(c)) {
            i += 1;
        } else if (c === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i += 1;
        } else if (c === "'") {
            let v = '';
            i += 1;
            for (;;) {
                if (i >= sql.length) throw new Error(`unterminated string in ${sql}`);
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") {
                        v += "'";
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    v += sql[i];
                    i += 1;
                }
            }
            toks.push({ t: 'str', v });
        } else if (c === '|' && sql[i + 1] === '|') {
            toks.push({ t: 'op', v: '||' });
            i += 2;
        } else if ('(),;'.includes(c)) {
            toks.push({ t: 'punct', v: c });
            i += 1;
        } else if ('+-*/<>=!%'.includes(c)) {
            let v = c;
            i += 1;
            while (i < sql.length && '<>=!'.includes(sql[i]) && v.length < 2) {
                v += sql[i];
                i += 1;
            }
            toks.push({ t: 'op', v });
        } else {
            let v = '';
            while (
                i < sql.length &&
                !/\s/.test(sql[i]) &&
                !"'(),;+-*/<>=!%|".includes(sql[i])
            ) {
                v += sql[i];
                i += 1;
            }
            if (v === '') {
                v = sql[i];
                i += 1;
            }
            toks.push({ t: 'word', v });
        }
    }
    return toks;
};

/** Merges `'a' || 'b'` runs into one string token (constant folding). */
export const fold = (toks: Tok[]): Tok[] => {
    const out: Tok[] = [];
    for (let i = 0; i < toks.length; i += 1) {
        const tok = toks[i];
        if (
            tok.t === 'str' &&
            out.length >= 2 &&
            out[out.length - 1].t === 'op' &&
            out[out.length - 1].v === '||' &&
            out[out.length - 2].t === 'str'
        ) {
            out.pop();
            out[out.length - 1] = { t: 'str', v: out[out.length - 1].v + tok.v };
        } else {
            out.push(tok);
        }
    }
    return out;
};

export type Call = { name: string; args: string[]; literal: boolean[] };

/**
 * Substitutes parameters, folds, and returns every call of the named function(s) with its
 * arguments: a literal argument's value, or the argument's tokens joined with spaces.
 */
export const calls = (
    sql: string,
    name: string,
    params: Record<string, unknown> = {},
): Call[] => {
    const toks = fold(tokenize(substitute(sql, params)));
    const found: Call[] = [];
    for (let i = 0; i < toks.length - 1; i += 1) {
        if (
            toks[i].t === 'word' &&
            toks[i].v.toLowerCase() === name.toLowerCase() &&
            toks[i + 1].v === '('
        ) {
            const args: string[] = [];
            const literal: boolean[] = [];
            let depth = 0;
            let cur: Tok[] = [];
            for (let j = i + 2; j < toks.length; j += 1) {
                const tok = toks[j];
                if (tok.t === 'punct' && tok.v === '(') depth += 1;
                if (tok.t === 'punct' && tok.v === ')') {
                    if (depth === 0) {
                        if (cur.length) {
                            args.push(cur.length === 1 && cur[0].t === 'str' ? cur[0].v : cur.map((x) => x.v).join(' '));
                            literal.push(cur.length === 1 && cur[0].t === 'str');
                        }
                        break;
                    }
                    depth -= 1;
                }
                if (tok.t === 'punct' && tok.v === ',' && depth === 0) {
                    args.push(cur.length === 1 && cur[0].t === 'str' ? cur[0].v : cur.map((x) => x.v).join(' '));
                    literal.push(cur.length === 1 && cur[0].t === 'str');
                    cur = [];
                } else {
                    cur.push(tok);
                }
            }
            found.push({ name: toks[i].v, args, literal });
        }
    }
    return found;
};

/** The single call of a function; fails the test when there is not exactly one. */
export const onlyCall = (
    sql: string,
    name: string,
    params: Record<string, unknown> = {},
): Call => {
    const found = calls(sql, name, params);
    if (found.length !== 1) {
        throw new Error(`expected one ${name}() call, found ${found.length} in: ${sql}`);
    }
    return found[0];
};

/** The SQL outside string literals, lower-cased, after substitution and folding. */
export const codeOutsideLiterals = (
    sql: string,
    params: Record<string, unknown> = {},
): string =>
    fold(tokenize(substitute(sql, params)))
        .filter((tok) => tok.t !== 'str')
        .map((tok) => tok.v)
        .join(' ')
        .toLowerCase();

/** Every string literal in the SQL after substitution and folding. */
export const literals = (
    sql: string,
    params: Record<string, unknown> = {},
): string[] =>
    fold(tokenize(substitute(sql, params)))
        .filter((tok) => tok.t === 'str')
        .map((tok) => tok.v);

/** True when the SQL is time-range-aware: it reads both reserved bounds. */
export const isTimeRangeAware = (sql: string): boolean =>
    sql.includes('${ld.parameters.__from}') && sql.includes('${ld.parameters.__to}');

export const codes = (warnings: Array<{ code: string }> = []) =>
    warnings.map((w) => w.code);

/** A warning is structured: a code, a readable message, never empty. */
export const expectStructuredWarnings = (warnings: any[]) => {
    expect(Array.isArray(warnings)).toBe(true);
    for (const w of warnings) {
        expect(typeof w.code).toBe('string');
        expect(w.code).toMatch(/^[a-z0-9-]+$/);
        expect(typeof w.message).toBe('string');
        expect(w.message.trim().length).toBeGreaterThan(0);
    }
};

/** Grafana datasources as `grafana_data_sources.tf` defines them (type, name, uid). */
export const DATASOURCES = [
    { uid: 'tmTXpZC4k', name: 'Prometheus-Production', type: 'prometheus' },
    { uid: 'dW0QDuzIz', name: 'Prometheus-Staging', type: 'prometheus' },
    { uid: 'JOxT6xE4z', name: 'Cloudwatch Production', type: 'cloudwatch' },
    { uid: 'uHbTebEVk', name: 'Cloudwatch Staging', type: 'cloudwatch' },
    { uid: 'GA4WkvzSz', name: 'Loki-Production', type: 'loki' },
    { uid: 'betb591q7ij28b', name: 'GitHub', type: 'grafana-github-datasource' },
    { uid: '2qa_JwISk', name: 'Sentry', type: 'grafana-sentry-datasource' },
    { uid: 'pg-platform', name: 'Platform DB', type: 'grafana-postgresql-datasource' },
];

export const PROM = { type: 'prometheus', uid: 'tmTXpZC4k' };
export const LOKI = { type: 'loki', uid: 'GA4WkvzSz' };
export const CW = { type: 'cloudwatch', uid: 'JOxT6xE4z' };
export const PG = { type: 'grafana-postgresql-datasource', uid: 'pg-platform' };
export const EXPR = { type: '__expr__', uid: '__expr__' };
