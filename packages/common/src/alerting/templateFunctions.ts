// Values and functions of the message template engine (ENG-1799): how Go's
// text/template prints, tests, compares and indexes values, and its built-in
// functions plus Grafana's simple string helpers.
import { AlertTemplateError } from './templateTypes';

export const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const typeName = (v: unknown): string => {
    if (v === undefined || v === null) return 'nil';
    if (Array.isArray(v)) return 'list';
    if (isRecord(v)) return 'map';
    if (typeof v === 'boolean') return 'bool';
    return typeof v;
};

const goExponent = (s: string) => s.replace(/e([+-])(\d)$/, 'e$10$2');

const formatNumber = (n: number): string => {
    if (Number.isInteger(n) || !Number.isFinite(n)) {
        if (n === Infinity) return '+Inf';
        if (n === -Infinity) return '-Inf';
        if (Number.isNaN(n)) return 'NaN';
        return Math.abs(n) < 1e21 ? n.toFixed(0) : goExponent(String(n));
    }
    // Go's %v for floats: shortest form, exponent when < -4 or >= 21.
    if (Math.abs(n) < 1e-4) return goExponent(n.toExponential());
    return goExponent(String(n));
};

/** Prints a value the way Go's fmt %v does; nil and missing values print ''. */
export const formatValue = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return formatNumber(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return `[${v.map(formatValue).join(' ')}]`;
    if (isRecord(v)) {
        const entries = Object.keys(v)
            .sort()
            .map((k) => `${k}:${formatValue(v[k])}`);
        return `map[${entries.join(' ')}]`;
    }
    return String(v);
};

/** Go's notion of truth: false, 0, '', nil and empty lists/maps are false. */
export const truth = (v: unknown): boolean => {
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (isRecord(v)) return Object.keys(v).length > 0;
    return Boolean(v);
};

export const fieldOf = (value: unknown, name: string): unknown => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
        if (name === 'Firing' || name === 'Resolved') {
            const status = name.toLowerCase();
            return value.filter((a) => isRecord(a) && a.Status === status);
        }
        throw new AlertTemplateError(
            `can't evaluate field ${name} in type list`,
        );
    }
    if (isRecord(value)) {
        return Object.prototype.hasOwnProperty.call(value, name)
            ? value[name]
            : undefined;
    }
    throw new AlertTemplateError(
        `can't evaluate field ${name} in type ${typeName(value)}`,
    );
};

const utf8Length = (s: string): number =>
    [...s].reduce((n, ch) => {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80) return n + 1;
        if (cp < 0x800) return n + 2;
        if (cp < 0x10000) return n + 3;
        return n + 4;
    }, 0);

// ---------------------------------------------------------------- functions

const arity = (name: string, args: unknown[], min: number, max = min) => {
    if (args.length < min || args.length > max) {
        const want = min === max ? `${min}` : `${min}-${max}`;
        throw new AlertTemplateError(
            `wrong number of args for ${name}: want ${want} got ${args.length}`,
        );
    }
};

/** A comparable basic value; a nil compares as the other side's zero value. */
const basic = (v: unknown, other: unknown): unknown => {
    if (v === undefined || v === null) {
        if (typeof other === 'string') return '';
        if (typeof other === 'number') return 0;
        if (typeof other === 'boolean') return false;
        return null;
    }
    if (typeof v === 'object') {
        throw new AlertTemplateError(`non-comparable type ${typeName(v)}`);
    }
    return v;
};

const equal = (a: unknown, b: unknown): boolean => {
    const x = basic(a, b);
    const y = basic(b, a);
    if (x !== null && y !== null && typeof x !== typeof y) {
        throw new AlertTemplateError('incompatible types for comparison');
    }
    return x === y;
};

const less = (a: unknown, b: unknown): boolean => {
    const x = basic(a, b);
    const y = basic(b, a);
    if (
        (typeof x === 'number' && typeof y === 'number') ||
        (typeof x === 'string' && typeof y === 'string')
    ) {
        return x < y;
    }
    if (typeof x !== typeof y) {
        throw new AlertTemplateError('incompatible types for comparison');
    }
    throw new AlertTemplateError(`invalid type for comparison: ${typeName(x)}`);
};

const compare =
    (name: string, test: (a: unknown, b: unknown) => boolean) =>
    (args: unknown[]) => {
        arity(name, args, 2);
        return test(args[0], args[1]);
    };

const toInteger = (name: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new AlertTemplateError(
            `${name}: cannot index with ${typeName(v)} ${formatValue(v)}`,
        );
    }
    return v;
};

/** Go's fmt.Sprint: spaces between operands when neither is a string. */
const sprint = (args: unknown[]): string =>
    args.reduce<string>((out, arg, i) => {
        const sep =
            i > 0 && typeof arg !== 'string' && typeof args[i - 1] !== 'string'
                ? ' '
                : '';
        return out + sep + formatValue(arg);
    }, '');

/** The single string argument of an escaper, or Sprint of all of them. */
const escaperInput = (args: unknown[]): string =>
    args.length === 1 && typeof args[0] === 'string' ? args[0] : sprint(args);

const hex = (c: string) =>
    `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

const sprintf = (format: string, args: unknown[]): string => {
    let n = 0;
    const out = format.replace(
        /%([-+# 0]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g,
        (
            _whole,
            flags: string,
            width?: string,
            precision?: string,
            verb?: string,
        ) => {
            if (verb === '%') return '%';
            if (n >= args.length) return `%!${verb}(MISSING)`;
            const arg = args[n];
            n += 1;
            const prec =
                precision === undefined ? undefined : Number(precision);
            const bad = () => `%!${verb}(${typeName(arg)}=${formatValue(arg)})`;
            const signed = (s: string) =>
                flags.includes('+') && !s.startsWith('-') ? `+${s}` : s;
            let s: string;
            let numeric = false;
            switch (verb) {
                case 'v':
                    s = formatValue(arg);
                    break;
                case 's':
                    s = formatValue(arg);
                    if (prec !== undefined) s = [...s].slice(0, prec).join('');
                    break;
                case 'q':
                    s = JSON.stringify(formatValue(arg));
                    break;
                case 't':
                    s = typeof arg === 'boolean' ? formatValue(arg) : bad();
                    break;
                case 'd':
                    numeric = true;
                    s =
                        typeof arg === 'number' && Number.isInteger(arg)
                            ? signed(arg.toFixed(0))
                            : bad();
                    break;
                case 'f':
                case 'F':
                    numeric = true;
                    s =
                        typeof arg === 'number'
                            ? signed(arg.toFixed(prec ?? 6))
                            : bad();
                    break;
                case 'e':
                    numeric = true;
                    s =
                        typeof arg === 'number'
                            ? signed(goExponent(arg.toExponential(prec ?? 6)))
                            : bad();
                    break;
                case 'g':
                    numeric = true;
                    if (typeof arg !== 'number') s = bad();
                    else if (prec === undefined) s = signed(formatNumber(arg));
                    else
                        s = signed(
                            goExponent(
                                String(Number(arg.toPrecision(prec || 1))),
                            ),
                        );
                    break;
                case 'x':
                case 'X': {
                    if (typeof arg === 'number' && Number.isInteger(arg)) {
                        numeric = true;
                        s = arg.toString(16);
                    } else if (typeof arg === 'string') {
                        s = [...new TextEncoder().encode(arg)]
                            .map((b) => b.toString(16).padStart(2, '0'))
                            .join('');
                    } else {
                        s = bad();
                    }
                    if (verb === 'X') s = s.toUpperCase();
                    break;
                }
                default:
                    s = bad();
            }
            const w = width === undefined ? 0 : Number(width);
            if (s.length >= w) return s;
            if (flags.includes('-')) return s.padEnd(w);
            if (numeric && flags.includes('0')) {
                const sign = /^[+-]/.test(s) ? s[0] : '';
                return (
                    sign + s.slice(sign.length).padStart(w - sign.length, '0')
                );
            }
            return s.padStart(w);
        },
    );
    const extra = args.slice(n);
    return extra.length
        ? `${out}%!(EXTRA ${extra.map((a) => `${typeName(a)}=${formatValue(a)}`).join(', ')})`
        : out;
};

const stringArg = (name: string, v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v === undefined || v === null) return '';
    throw new AlertTemplateError(
        `${name}: expected string; found ${typeName(v)}`,
    );
};

export const TEMPLATE_FUNCTIONS: Record<string, (args: unknown[]) => unknown> =
    {
        and: (args) => {
            arity('and', args, 1, Infinity);
            return args.find((a) => !truth(a)) ?? args[args.length - 1];
        },
        or: (args) => {
            arity('or', args, 1, Infinity);
            return args.find((a) => truth(a)) ?? args[args.length - 1];
        },
        not: (args) => {
            arity('not', args, 1);
            return !truth(args[0]);
        },
        len: (args) => {
            arity('len', args, 1);
            const [v] = args;
            if (v === undefined) return 0;
            if (typeof v === 'string') return utf8Length(v);
            if (Array.isArray(v)) return v.length;
            if (isRecord(v)) return Object.keys(v).length;
            throw new AlertTemplateError(`len of type ${typeName(v)}`);
        },
        index: (args) => {
            arity('index', args, 1, Infinity);
            return args.slice(1).reduce((item, key) => {
                if (Array.isArray(item) || typeof item === 'string') {
                    const i = toInteger('index', key);
                    if (i < 0 || i >= item.length) {
                        throw new AlertTemplateError(
                            `error calling index: index out of range: ${i}`,
                        );
                    }
                    return typeof item === 'string'
                        ? item.charCodeAt(i)
                        : item[i];
                }
                if (isRecord(item)) {
                    const k = formatValue(key);
                    return Object.prototype.hasOwnProperty.call(item, k)
                        ? item[k]
                        : undefined;
                }
                throw new AlertTemplateError(
                    `error calling index: can't index item of type ${typeName(item)}`,
                );
            }, args[0]);
        },
        slice: (args) => {
            arity('slice', args, 1, 3);
            const [item, ...bounds] = args;
            if (!Array.isArray(item) && typeof item !== 'string') {
                throw new AlertTemplateError(
                    `error calling slice: can't slice item of type ${typeName(item)}`,
                );
            }
            if (typeof item === 'string' && bounds.length > 2) {
                throw new AlertTemplateError(
                    'error calling slice: cannot 3-index slice a string',
                );
            }
            const [start = 0, end = item.length] = bounds.map((b) =>
                toInteger('slice', b),
            );
            if (start < 0 || end < start || end > item.length) {
                throw new AlertTemplateError(
                    `error calling slice: index out of range: ${start}:${end}`,
                );
            }
            return item.slice(start, end);
        },
        eq: (args) => {
            if (args.length < 2) {
                throw new AlertTemplateError('missing argument for comparison');
            }
            return args.slice(1).some((b) => equal(args[0], b));
        },
        ne: compare('ne', (a, b) => !equal(a, b)),
        lt: compare('lt', less),
        le: compare('le', (a, b) => less(a, b) || equal(a, b)),
        gt: compare('gt', (a, b) => less(b, a)),
        ge: compare('ge', (a, b) => less(b, a) || equal(a, b)),
        print: sprint,
        println: (args) => `${args.map(formatValue).join(' ')}\n`,
        printf: (args) => {
            arity('printf', args, 1, Infinity);
            return sprintf(stringArg('printf', args[0]), args.slice(1));
        },
        html: (args) =>
            escaperInput(args).replace(
                /[&<>"'\0]/g,
                (c) =>
                    ({
                        '&': '&amp;',
                        '<': '&lt;',
                        '>': '&gt;',
                        '"': '&#34;',
                        "'": '&#39;',
                        '\0': '�',
                    })[c]!,
            ),
        js: (args) =>
            escaperInput(args).replace(
                // eslint-disable-next-line no-control-regex
                /[\\'"<>&=\u0000-\u001f]/g,
                (c) => ({ '\\': '\\\\', "'": "\\'", '"': '\\"' })[c] ?? hex(c),
            ),
        urlquery: (args) =>
            encodeURIComponent(escaperInput(args))
                .replace(
                    /[!'()*]/g,
                    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
                )
                .replace(/%20/g, '+'),
        toUpper: (args) => {
            arity('toUpper', args, 1);
            return stringArg('toUpper', args[0]).toUpperCase();
        },
        toLower: (args) => {
            arity('toLower', args, 1);
            return stringArg('toLower', args[0]).toLowerCase();
        },
        title: (args) => {
            arity('title', args, 1);
            return stringArg('title', args[0]).replace(
                /(^|[^\p{L}\p{N}_])(\p{L})/gu,
                (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
            );
        },
        trimSpace: (args) => {
            arity('trimSpace', args, 1);
            return stringArg('trimSpace', args[0]).trim();
        },
        join: (args) => {
            arity('join', args, 2);
            const [sep, list] = args;
            if (!Array.isArray(list)) {
                throw new AlertTemplateError(
                    `join: expected list; found ${typeName(list)}`,
                );
            }
            return list.map(formatValue).join(stringArg('join', sep));
        },
        stringSlice: (args) => args.map((a) => stringArg('stringSlice', a)),
        safeHtml: (args) => {
            arity('safeHtml', args, 1);
            return stringArg('safeHtml', args[0]);
        },
    };
