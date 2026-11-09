// Lexer and parser of the message template engine (ENG-1799): Go
// text/template syntax into a node tree, collecting `define`d templates.
import { TEMPLATE_FUNCTIONS } from './templateFunctions';
import { AlertTemplateError } from './templateTypes';

type TokenKind =
    | 'field'
    | 'dot'
    | 'variable'
    | 'ident'
    | 'keyword'
    | 'literal'
    | 'lparen'
    | 'rparen'
    | 'pipe'
    | 'declare'
    | 'assign'
    | 'comma';

type Token = {
    kind: TokenKind;
    /** Source text, or the name for fields (without the leading '.'). */
    text: string;
    /** The value of a literal token. */
    value?: unknown;
    /** Whether whitespace came right before the token. */
    spaced: boolean;
};

type Item =
    | { kind: 'text'; text: string }
    | { kind: 'action'; tokens: Token[]; line: number };

const KEYWORDS = new Set([
    'if',
    'else',
    'end',
    'range',
    'with',
    'define',
    'template',
    'block',
    'break',
    'continue',
]);

const isSpace = (c: string | undefined) =>
    c === ' ' || c === '\t' || c === '\r' || c === '\n';
const trimLeftSpace = (s: string) => s.replace(/^[ \t\r\n]+/, '');
const trimRightSpace = (s: string) => s.replace(/[ \t\r\n]+$/, '');
const countLines = (s: string) => s.split('\n').length - 1;

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const VARIABLE_RE = /\$[A-Za-z0-9_]*/y;
const NUMBER_RE =
    /[+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;

const matchAt = (re: RegExp, src: string, at: number): string | undefined => {
    // eslint-disable-next-line no-param-reassign
    re.lastIndex = at;
    return re.exec(src)?.[0];
};

const parseNumber = (text: string): number | undefined => {
    const sign = text.startsWith('-') ? -1 : 1;
    const body = text.replace(/^[+-]/, '').replace(/_/g, '');
    const prefixed = /^0([xXbBoO])(.+)$/.exec(body);
    let value: number;
    if (prefixed) {
        const base = { x: 16, b: 2, o: 8 }[
            prefixed[1].toLowerCase() as 'x' | 'b' | 'o'
        ];
        value = parseInt(prefixed[2], base);
    } else {
        value = Number(body);
    }
    return Number.isFinite(value) ? sign * value : undefined;
};

const ESCAPES: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    '"': '"',
    "'": "'",
};

/** Reads a quoted Go string or char starting at `start` (the quote). */
const readQuoted = (
    src: string,
    start: number,
    fail: (msg: string) => never,
): { value: string; end: number } => {
    const quote = src[start];
    let value = '';
    let i = start + 1;
    for (;;) {
        const c = src[i];
        if (c === undefined || c === '\n') {
            fail(
                quote === '"'
                    ? 'unterminated quoted string'
                    : 'unterminated character constant',
            );
        }
        if (c === quote) return { value, end: i + 1 };
        if (c !== '\\') {
            value += c;
            i += 1;
        } else {
            const e = src[i + 1];
            const hex = { x: 2, u: 4, U: 8 }[e as 'x' | 'u' | 'U'];
            if (e !== undefined && e in ESCAPES) {
                value += ESCAPES[e];
                i += 2;
            } else if (hex) {
                const digits = src.slice(i + 2, i + 2 + hex);
                if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(digits)) {
                    fail(`invalid escape \\${e}${digits}`);
                }
                value += String.fromCodePoint(parseInt(digits, 16));
                i += 2 + hex;
            } else if (/^[0-7]{3}$/.test(src.slice(i + 1, i + 4))) {
                value += String.fromCharCode(
                    parseInt(src.slice(i + 1, i + 4), 8),
                );
                i += 4;
            } else {
                fail(`unknown escape sequence \\${e ?? ''}`);
            }
        }
    }
};

const lex = (src: string, name: string): Item[] => {
    const items: Item[] = [];
    let pos = 0;
    let line = 1;
    let trimNext = false;
    const failAt =
        (at: number) =>
        (msg: string): never => {
            throw new AlertTemplateError(`template: ${name}:${at}: ${msg}`);
        };
    const pushText = (raw: string, trimLeft: boolean, trimRight: boolean) => {
        let text = trimLeft ? trimLeftSpace(raw) : raw;
        if (trimRight) text = trimRightSpace(text);
        if (text) items.push({ kind: 'text', text });
    };

    while (pos < src.length) {
        const open = src.indexOf('{{', pos);
        if (open === -1) {
            pushText(src.slice(pos), trimNext, false);
            break;
        }
        let i = open + 2;
        const trimLeft = src[i] === '-' && isSpace(src[i + 1]);
        if (trimLeft) i += 2;
        const raw = src.slice(pos, open);
        pushText(raw, trimNext, trimLeft);
        line += countLines(raw);
        const startLine = line;
        const fail = failAt(startLine);
        trimNext = false;

        if (src.startsWith('/*', i)) {
            const close = src.indexOf('*/', i + 2);
            if (close === -1) fail('unclosed comment');
            line += countLines(src.slice(i, close));
            i = close + 2;
            if (isSpace(src[i]) && src.startsWith('-}}', i + 1)) {
                trimNext = true;
                pos = i + 4;
            } else if (src.startsWith('}}', i)) {
                pos = i + 2;
            } else {
                fail('comment ends before closing delimiter');
            }
        } else {
            const tokens: Token[] = [];
            let spaced = true;
            const push = (token: Omit<Token, 'spaced'>) => {
                tokens.push({ ...token, spaced });
                spaced = false;
            };
            for (;;) {
                const c = src[i];
                if (c === undefined) fail('unclosed action');
                if (isSpace(c)) {
                    let j = i;
                    while (isSpace(src[j])) j += 1;
                    if (src.startsWith('-}}', j)) {
                        trimNext = true;
                        line += countLines(src.slice(i, j));
                        i = j + 3;
                        break;
                    }
                    line += countLines(src.slice(i, j));
                    i = j;
                    spaced = true;
                } else if (src.startsWith('}}', i)) {
                    i += 2;
                    break;
                } else if (c === '.' && matchAt(IDENT_RE, src, i + 1)) {
                    const ident = matchAt(IDENT_RE, src, i + 1)!;
                    push({ kind: 'field', text: ident });
                    i += 1 + ident.length;
                } else if (
                    /[0-9]/.test(c) ||
                    ((c === '-' || c === '+' || c === '.') &&
                        /[0-9.]/.test(src[i + 1] ?? '') &&
                        matchAt(NUMBER_RE, src, i))
                ) {
                    const text = matchAt(NUMBER_RE, src, i) ?? c;
                    const value = parseNumber(text);
                    if (
                        value === undefined ||
                        /[A-Za-z0-9_.]/.test(src[i + text.length] ?? '')
                    ) {
                        fail(`bad number syntax: "${text}"`);
                    }
                    push({ kind: 'literal', text, value });
                    i += text.length;
                } else if (c === '.') {
                    push({ kind: 'dot', text: '.' });
                    i += 1;
                } else if (c === '$') {
                    const text = matchAt(VARIABLE_RE, src, i)!;
                    push({ kind: 'variable', text });
                    i += text.length;
                } else if (c === '"') {
                    const { value, end } = readQuoted(src, i, fail);
                    push({ kind: 'literal', text: src.slice(i, end), value });
                    i = end;
                } else if (c === "'") {
                    const { value, end } = readQuoted(src, i, fail);
                    if ([...value].length !== 1) {
                        fail(
                            `malformed character constant: ${src.slice(i, end)}`,
                        );
                    }
                    push({
                        kind: 'literal',
                        text: src.slice(i, end),
                        value: value.codePointAt(0),
                    });
                    i = end;
                } else if (c === '`') {
                    const end = src.indexOf('`', i + 1);
                    if (end === -1) fail('unterminated raw quoted string');
                    const value = src.slice(i + 1, end);
                    push({
                        kind: 'literal',
                        text: src.slice(i, end + 1),
                        value,
                    });
                    line += countLines(value);
                    i = end + 1;
                } else if (c === ':' && src[i + 1] === '=') {
                    push({ kind: 'declare', text: ':=' });
                    i += 2;
                } else if (c === '=') {
                    push({ kind: 'assign', text: '=' });
                    i += 1;
                } else if (c === '(' || c === ')' || c === '|' || c === ',') {
                    const kinds = {
                        '(': 'lparen',
                        ')': 'rparen',
                        '|': 'pipe',
                        ',': 'comma',
                    } as const;
                    push({ kind: kinds[c], text: c });
                    i += 1;
                } else if (matchAt(IDENT_RE, src, i)) {
                    const text = matchAt(IDENT_RE, src, i)!;
                    if (text === 'true' || text === 'false') {
                        push({ kind: 'literal', text, value: text === 'true' });
                    } else if (text === 'nil') {
                        push({ kind: 'literal', text, value: null });
                    } else {
                        push({
                            kind: KEYWORDS.has(text) ? 'keyword' : 'ident',
                            text,
                        });
                    }
                    i += text.length;
                } else {
                    fail(`unexpected "${c}" in action`);
                }
            }
            items.push({ kind: 'action', tokens, line: startLine });
            pos = i;
        }
    }
    return items;
};

// ---------------------------------------------------------------- parser

export type Pipeline = {
    decl: string[];
    assign: boolean;
    cmds: Operand[][];
};

export type Operand =
    | { kind: 'dot' }
    | { kind: 'field'; names: string[] }
    | { kind: 'variable'; name: string; names: string[] }
    | { kind: 'func'; name: string }
    | { kind: 'literal'; value: unknown }
    | { kind: 'pipe'; pipe: Pipeline; names: string[] };

export type ControlNode = {
    kind: 'if' | 'with' | 'range';
    pipe: Pipeline;
    list: Node[];
    elseList: Node[] | undefined;
};

export type Node =
    | { kind: 'text'; text: string }
    | { kind: 'action'; pipe: Pipeline }
    | ControlNode
    | { kind: 'template'; name: string; pipe: Pipeline | undefined }
    | { kind: 'break' | 'continue' };

type ListEnd = { kind: 'end' | 'else'; rest: Token[]; line: number };

const isEmptyTree = (nodes: Node[]) =>
    nodes.every((n) => n.kind === 'text' && trimLeftSpace(n.text) === '');

class Parser {
    private index = 0;

    private rangeDepth = 0;

    private line = 1;

    constructor(
        private readonly items: Item[],
        private readonly name: string,
        private readonly defines: Map<string, Node[]>,
    ) {}

    parse(): Node[] {
        return this.parseList(true).nodes;
    }

    private fail(msg: string): never {
        throw new AlertTemplateError(
            `template: ${this.name}:${this.line}: ${msg}`,
        );
    }

    private parseList(top: boolean): { nodes: Node[]; end?: ListEnd } {
        const nodes: Node[] = [];
        while (this.index < this.items.length) {
            const item = this.items[this.index];
            this.index += 1;
            const [first, ...rest] = item.kind === 'action' ? item.tokens : [];
            if (item.kind === 'text') {
                nodes.push(item);
            } else if (first?.kind === 'keyword') {
                this.line = item.line;
                switch (first.text) {
                    case 'end':
                    case 'else':
                        if (top) this.fail(`unexpected {{${first.text}}}`);
                        if (first.text === 'end' && rest.length) {
                            this.fail(`unexpected ${rest[0].text} in end`);
                        }
                        return {
                            nodes,
                            end: { kind: first.text, rest, line: item.line },
                        };
                    case 'if':
                    case 'with':
                    case 'range':
                        nodes.push(this.parseControl(first.text, rest));
                        break;
                    case 'template':
                        nodes.push(this.parseTemplateCall(rest, false));
                        break;
                    case 'block':
                        nodes.push(this.parseTemplateCall(rest, true));
                        break;
                    case 'define':
                        if (!top) this.fail('unexpected {{define}}');
                        this.parseDefine(rest);
                        break;
                    default:
                        if (this.rangeDepth === 0) {
                            this.fail(`{{${first.text}}} outside {{range}}`);
                        }
                        if (rest.length) {
                            this.fail(
                                `unexpected ${rest[0].text} in {{${first.text}}}`,
                            );
                        }
                        nodes.push({
                            kind: first.text as 'break' | 'continue',
                        });
                }
            } else {
                this.line = item.line;
                nodes.push({
                    kind: 'action',
                    pipe: this.parsePipeline(item.tokens, 'command', 1),
                });
            }
        }
        if (!top) this.fail('unexpected EOF');
        return { nodes };
    }

    private parseUntilEnd(context: string): Node[] {
        const { nodes, end } = this.parseList(false);
        if (end?.kind !== 'end') this.fail(`unexpected {{else}} in ${context}`);
        return nodes;
    }

    private parseControl(kind: 'if' | 'with' | 'range', tokens: Token[]): Node {
        const pipe = this.parsePipeline(tokens, kind, kind === 'range' ? 2 : 1);
        if (kind === 'range') this.rangeDepth += 1;
        const body = this.parseList(false);
        if (kind === 'range') this.rangeDepth -= 1;
        let elseList: Node[] | undefined;
        if (body.end?.kind === 'else') {
            const [next, ...rest] = body.end.rest;
            if (next) {
                this.line = body.end.line;
                if (kind === 'range' || next.text !== kind) {
                    this.fail(`unexpected ${next.text} in else`);
                }
                elseList = [this.parseControl(kind, rest)];
            } else {
                elseList = this.parseUntilEnd(kind);
            }
        }
        return { kind, pipe, list: body.nodes, elseList };
    }

    private templateName(tokens: Token[], context: string): string {
        const [first] = tokens;
        if (first?.kind !== 'literal' || typeof first.value !== 'string') {
            this.fail(`${context} name must be a string`);
        }
        return first.value;
    }

    private define(name: string, nodes: Node[]) {
        // As in Go, an empty definition doesn't replace a non-empty one.
        if (!isEmptyTree(nodes) || !this.defines.has(name)) {
            this.defines.set(name, nodes);
        }
    }

    private parseDefine(tokens: Token[]) {
        const name = this.templateName(tokens, 'define');
        if (tokens.length > 1)
            this.fail(`unexpected ${tokens[1].text} in define`);
        this.define(name, this.parseUntilEnd('define'));
    }

    private parseTemplateCall(tokens: Token[], isBlock: boolean): Node {
        const context = isBlock ? 'block' : 'template';
        const name = this.templateName(tokens, context);
        const pipe =
            tokens.length > 1
                ? this.parsePipeline(tokens.slice(1), `${context} clause`, 0)
                : undefined;
        if (isBlock) {
            const depth = this.rangeDepth;
            this.rangeDepth = 0;
            this.define(name, this.parseUntilEnd('block'));
            this.rangeDepth = depth;
        }
        return { kind: 'template', name, pipe };
    }

    private parsePipeline(
        tokens: Token[],
        context: string,
        maxDecl: number,
    ): Pipeline {
        const isDecl = (t: Token | undefined) =>
            t?.kind === 'declare' || t?.kind === 'assign';
        let pos = 0;
        let decl: string[] = [];
        if (tokens[0]?.kind === 'variable' && isDecl(tokens[1])) {
            decl = [tokens[0].text];
            pos = 2;
        } else if (
            tokens[0]?.kind === 'variable' &&
            tokens[1]?.kind === 'comma' &&
            tokens[2]?.kind === 'variable' &&
            isDecl(tokens[3])
        ) {
            decl = [tokens[0].text, tokens[2].text];
            pos = 4;
        }
        if (decl.length > maxDecl) {
            this.fail(`too many declarations in ${context}`);
        }
        const assign = decl.length > 0 && tokens[pos - 1].kind === 'assign';

        const cmds: Operand[][] = [];
        let cmd: Operand[] = [];
        while (pos < tokens.length) {
            if (tokens[pos].kind === 'pipe') {
                if (!cmd.length) this.fail(`missing command in ${context}`);
                cmds.push(cmd);
                cmd = [];
                pos += 1;
            } else {
                const [operand, next] = this.parseOperand(tokens, pos, context);
                cmd.push(operand);
                pos = next;
            }
        }
        if (!cmd.length) {
            this.fail(
                cmds.length
                    ? `missing command in ${context}`
                    : `missing value for ${context}`,
            );
        }
        cmds.push(cmd);
        cmds.forEach((c, i) => {
            if (c[0].kind === 'func') return;
            if (c[0].kind === 'literal' && c[0].value === null) {
                this.fail('nil is not a command');
            }
            if (c.length > 1 || i > 0) {
                this.fail(`can't give argument to non-function in ${context}`);
            }
        });
        return { decl, assign, cmds };
    }

    private parseOperand(
        tokens: Token[],
        pos: number,
        context: string,
    ): [Operand, number] {
        const token = tokens[pos];
        let next = pos + 1;
        let operand: Operand;
        switch (token.kind) {
            case 'dot':
                operand = { kind: 'dot' };
                break;
            case 'field':
                operand = { kind: 'field', names: [token.text] };
                break;
            case 'variable':
                operand = { kind: 'variable', name: token.text, names: [] };
                break;
            case 'literal':
                operand = { kind: 'literal', value: token.value };
                break;
            case 'ident':
                if (
                    !Object.prototype.hasOwnProperty.call(
                        TEMPLATE_FUNCTIONS,
                        token.text,
                    )
                ) {
                    this.fail(`function "${token.text}" not defined`);
                }
                operand = { kind: 'func', name: token.text };
                break;
            case 'lparen': {
                let depth = 1;
                let close = pos + 1;
                for (; close < tokens.length; close += 1) {
                    if (tokens[close].kind === 'lparen') depth += 1;
                    if (tokens[close].kind === 'rparen') depth -= 1;
                    if (depth === 0) break;
                }
                if (depth !== 0) this.fail('unclosed left paren');
                operand = {
                    kind: 'pipe',
                    pipe: this.parsePipeline(
                        tokens.slice(pos + 1, close),
                        'parenthesized pipeline',
                        0,
                    ),
                    names: [],
                };
                next = close + 1;
                break;
            }
            default:
                this.fail(`unexpected "${token.text}" in ${context}`);
        }
        while (tokens[next]?.kind === 'field' && !tokens[next].spaced) {
            if (
                operand.kind !== 'field' &&
                operand.kind !== 'variable' &&
                operand.kind !== 'pipe'
            ) {
                this.fail(`unexpected .${tokens[next].text} in ${context}`);
            }
            operand.names.push(tokens[next].text);
            next += 1;
        }
        return [operand, next];
    }
}

/**
 * Parses template source into the nodes of its top-level template, adding
 * each `define`d (or `block`) template to `defines`. `name` is the name used
 * in error messages.
 */
export const parseTemplateSource = (
    source: string,
    name: string,
    defines: Map<string, Node[]>,
): Node[] => new Parser(lex(source, name), name, defines).parse();
