/**
 * ENG-1799 importers: a parser and evaluator for the subset of Terraform's HCL that the Grafana
 * alerting Terraform uses. Pure: the CLI reads the files.
 *
 * Syntax: blocks with labels, attributes, `#`, `//` and `/* *\/` comments, quoted strings with
 * `${...}` interpolation, heredocs (`<<EOT`, and `<<-EOT` which strips the common indentation),
 * numbers, booleans, null, tuples, objects (`=` or `:`), references with `.attr` and `[index]`,
 * function calls, unary and binary operators, conditionals and `for` expressions. Template
 * directives (`%{if}`, `%{for}`) and splats (`[*]`, `.*`) are syntax errors.
 *
 * Evaluation never throws: what can't be known here (a `data` source, a secret, an unknown
 * function) is an `HclUnknown` holding the expression's source text, and stays symbolic.
 */

// The lexer, parser, syntax error and unknown value are one unit; they live together.
/* eslint-disable max-classes-per-file */

export class HclSyntaxError extends Error {
    readonly file: string | undefined;

    readonly line: number;

    readonly column: number;

    constructor(
        message: string,
        file: string | undefined,
        line: number,
        column: number,
    ) {
        super(`${file ?? '<hcl>'}:${line}:${column}: ${message}`);
        this.name = 'HclSyntaxError';
        this.file = file;
        this.line = line;
        this.column = column;
    }
}

// ------------------------------------------------------------------------------------- AST

type Node = { start: number; end: number };

export type HclTemplatePart = string | HclExpr;

export type HclObjectItem = {
    /** The key expression; a bare identifier key is a template holding its name. */
    key: HclExpr;
    value: HclExpr;
};

export type HclExpr = Node &
    (
        | { kind: 'literal'; value: null | boolean | number }
        | { kind: 'template'; parts: HclTemplatePart[] }
        | { kind: 'tuple'; items: HclExpr[] }
        | { kind: 'object'; items: HclObjectItem[] }
        | { kind: 'variable'; name: string }
        | { kind: 'getattr'; target: HclExpr; name: string }
        | { kind: 'index'; target: HclExpr; key: HclExpr }
        | { kind: 'call'; name: string; args: HclExpr[]; expandFinal: boolean }
        | { kind: 'unary'; op: '!' | '-'; operand: HclExpr }
        | { kind: 'binary'; op: string; left: HclExpr; right: HclExpr }
        | {
              kind: 'conditional';
              condition: HclExpr;
              whenTrue: HclExpr;
              whenFalse: HclExpr;
          }
        | {
              kind: 'for';
              keyVar: string | undefined;
              valueVar: string;
              collection: HclExpr;
              /** Set for an object `for` (`{for k, v in x : k => v}`). */
              keyExpr: HclExpr | undefined;
              valueExpr: HclExpr;
              condition: HclExpr | undefined;
              grouping: boolean;
          }
    );

export type HclAttribute = { name: string; expr: HclExpr; line: number };

export type HclBlock = {
    type: string;
    labels: string[];
    body: HclBody;
    line: number;
};

export type HclBody = { attributes: HclAttribute[]; blocks: HclBlock[] };

export type HclFile = {
    file: string | undefined;
    text: string;
    body: HclBody;
};

// ----------------------------------------------------------------------------------- lexer

type TokenType = 'ident' | 'number' | 'template' | 'newline' | 'punct' | 'eof';

type Token = {
    type: TokenType;
    /** ident: the name; number: the source; punct: the operator; template: unused. */
    value: string;
    parts?: HclTemplatePart[];
    start: number;
    end: number;
};

const PUNCTUATION = [
    '...',
    '==',
    '!=',
    '<=',
    '>=',
    '&&',
    '||',
    '=>',
    '{',
    '}',
    '[',
    ']',
    '(',
    ')',
    '=',
    ',',
    '.',
    ':',
    '?',
    '!',
    '<',
    '>',
    '+',
    '-',
    '*',
    '/',
    '%',
];

const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch);
const isIdentChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch);
const punctuationAt = (text: string, offset: number) =>
    PUNCTUATION.find((p) => text.startsWith(p, offset));

/** Parses the expression of an interpolation between two offsets of the same text. */
type InterpolationParser = (from: number, to: number) => HclExpr;

class Lexer {
    private readonly tokens: Token[] = [];

    constructor(
        private readonly text: string,
        private readonly file: string | undefined,
        private readonly from: number,
        private readonly to: number,
        private readonly parseInterpolation: InterpolationParser,
    ) {}

    error(message: string, offset: number): HclSyntaxError {
        const before = this.text.slice(0, offset);
        const line = before.split('\n').length;
        const column = offset - before.lastIndexOf('\n');
        return new HclSyntaxError(message, this.file, line, column);
    }

    tokenize(): Token[] {
        const { text } = this;
        let i = this.from;
        while (i < this.to) {
            const ch = text[i];
            if (ch === '\n') {
                this.tokens.push({
                    type: 'newline',
                    value: '\n',
                    start: i,
                    end: i + 1,
                });
                i += 1;
            } else if (/\s/.test(ch)) {
                i += 1;
            } else if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
                while (i < this.to && text[i] !== '\n') i += 1;
            } else if (ch === '/' && text[i + 1] === '*') {
                const close = text.indexOf('*/', i + 2);
                if (close === -1 || close + 2 > this.to) {
                    throw this.error('unterminated /* comment', i);
                }
                i = close + 2;
            } else if (ch === '"') {
                i = this.readQuoted(i);
            } else if (
                ch === '<' &&
                text[i + 1] === '<' &&
                /[-A-Za-z_]/.test(text[i + 2] ?? '')
            ) {
                i = this.readHeredoc(i);
            } else if (/[0-9]/.test(ch)) {
                const match = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(
                    text.slice(i, this.to),
                );
                const source = match ? match[0] : ch;
                this.tokens.push({
                    type: 'number',
                    value: source,
                    start: i,
                    end: i + source.length,
                });
                i += source.length;
            } else if (isIdentStart(ch)) {
                let end = i + 1;
                while (end < this.to && isIdentChar(text[end])) end += 1;
                this.tokens.push({
                    type: 'ident',
                    value: text.slice(i, end),
                    start: i,
                    end,
                });
                i = end;
            } else {
                const punct = punctuationAt(text, i);
                if (punct === undefined) {
                    throw this.error(
                        `unexpected character ${JSON.stringify(ch)}`,
                        i,
                    );
                }
                this.tokens.push({
                    type: 'punct',
                    value: punct,
                    start: i,
                    end: i + punct.length,
                });
                i += punct.length;
            }
        }
        this.tokens.push({
            type: 'eof',
            value: '',
            start: this.to,
            end: this.to,
        });
        return this.tokens;
    }

    /** The index just after the `}` closing the interpolation whose `${` is at `start`. */
    private interpolationEnd(start: number): number {
        const { text } = this;
        let depth = 0;
        let i = start + 2;
        while (i < this.to) {
            const ch = text[i];
            if (ch === '"') {
                i = this.skipQuoted(i);
            } else if (ch === '\n') {
                // Interpolations may span lines only inside heredocs; a newline in a quoted
                // string's interpolation is caught by the caller's own scan.
                i += 1;
            } else if (ch === '{') {
                depth += 1;
                i += 1;
            } else if (ch === '}') {
                if (depth === 0) return i + 1;
                depth -= 1;
                i += 1;
            } else {
                i += 1;
            }
        }
        throw this.error('unterminated ${ interpolation', start);
    }

    /** The index after the quoted string starting at `start` (used to skip nested strings). */
    private skipQuoted(start: number): number {
        const { text } = this;
        let i = start + 1;
        while (i < this.to) {
            const ch = text[i];
            if (ch === '\n') break;
            if (ch === '\\') {
                i += 2;
            } else if (ch === '"') {
                return i + 1;
            } else if (ch === '$' && text[i + 1] === '{') {
                i = this.interpolationEnd(i);
            } else {
                i += 1;
            }
        }
        throw this.error('unterminated string', start);
    }

    private interpolation(start: number): { expr: HclExpr; end: number } {
        const end = this.interpolationEnd(start);
        const expr = this.parseInterpolation(start + 2, end - 1);
        return { expr, end };
    }

    private readQuoted(start: number): number {
        const { text } = this;
        const parts: HclTemplatePart[] = [];
        let literal = '';
        let i = start + 1;
        const escapes: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '"': '"',
            '\\': '\\',
        };
        for (;;) {
            if (i >= this.to || text[i] === '\n') {
                throw this.error('unterminated string', start);
            }
            const ch = text[i];
            if (ch === '"') break;
            if (ch === '\\') {
                const next = text[i + 1];
                if (next === 'u' || next === 'U') {
                    const len = next === 'u' ? 4 : 8;
                    const hex = text.slice(i + 2, i + 2 + len);
                    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) {
                        throw this.error('invalid unicode escape', i);
                    }
                    literal += String.fromCodePoint(parseInt(hex, 16));
                    i += 2 + len;
                } else if (next !== undefined && next in escapes) {
                    literal += escapes[next];
                    i += 2;
                } else {
                    throw this.error(`invalid escape \\${next ?? ''}`, i);
                }
            } else if (
                (ch === '$' || ch === '%') &&
                text[i + 1] === ch &&
                text[i + 2] === '{'
            ) {
                literal += `${ch}{`;
                i += 3;
            } else if (ch === '$' && text[i + 1] === '{') {
                if (literal) parts.push(literal);
                literal = '';
                const { expr, end } = this.interpolation(i);
                if (text.slice(i, end).includes('\n')) {
                    throw this.error('unterminated string', start);
                }
                parts.push(expr);
                i = end;
            } else if (ch === '%' && text[i + 1] === '{') {
                throw this.error(
                    'template directives (%{...}) are not supported',
                    i,
                );
            } else {
                literal += ch;
                i += 1;
            }
        }
        if (literal || parts.length === 0) parts.push(literal);
        this.tokens.push({
            type: 'template',
            value: '',
            parts,
            start,
            end: i + 1,
        });
        return i + 1;
    }

    private readHeredoc(start: number): number {
        const { text } = this;
        const header = /^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(
            text.slice(start, this.to),
        );
        if (!header) throw this.error('invalid heredoc', start);
        const indent = header[1] === '-';
        const marker = header[2];
        const bodyStart = start + header[0].length;
        // Lines up to the closing marker.
        const lines: { start: number; end: number }[] = [];
        let lineStart = bodyStart;
        let close = -1;
        while (lineStart < this.to) {
            const nl = text.indexOf('\n', lineStart);
            const lineEnd = nl === -1 || nl > this.to ? this.to : nl;
            if (text.slice(lineStart, lineEnd).trim() === marker) {
                close = lineEnd;
                break;
            }
            lines.push({ start: lineStart, end: lineEnd });
            lineStart = lineEnd + 1;
        }
        if (close === -1) {
            throw this.error(
                `unterminated heredoc (no closing ${marker})`,
                start,
            );
        }
        const strip = indent
            ? Math.min(
                  ...lines
                      .filter((l) => text.slice(l.start, l.end).trim() !== '')
                      .map(
                          (l) =>
                              /^[ \t]*/.exec(text.slice(l.start, l.end))![0]
                                  .length,
                      ),
                  Infinity,
              )
            : 0;
        const parts: HclTemplatePart[] = [];
        let literal = '';
        lines.forEach((l) => {
            let i = Math.min(
                l.start + (Number.isFinite(strip) ? strip : 0),
                l.end,
            );
            while (i < l.end) {
                const ch = text[i];
                if (
                    (ch === '$' || ch === '%') &&
                    text[i + 1] === ch &&
                    text[i + 2] === '{'
                ) {
                    literal += `${ch}{`;
                    i += 3;
                } else if (ch === '$' && text[i + 1] === '{') {
                    if (literal) parts.push(literal);
                    literal = '';
                    const { expr, end } = this.interpolation(i);
                    parts.push(expr);
                    i = end;
                } else if (ch === '%' && text[i + 1] === '{') {
                    throw this.error(
                        'template directives (%{...}) are not supported',
                        i,
                    );
                } else {
                    literal += ch;
                    i += 1;
                }
            }
            literal += '\n';
        });
        if (literal || parts.length === 0) parts.push(literal);
        this.tokens.push({
            type: 'template',
            value: '',
            parts,
            start,
            end: close,
        });
        return close;
    }
}

// ---------------------------------------------------------------------------------- parser

const BINARY_PRECEDENCE: Record<string, number> = {
    '||': 1,
    '&&': 2,
    '==': 3,
    '!=': 3,
    '<': 4,
    '<=': 4,
    '>': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6,
};

class Parser {
    private pos = 0;

    /** Inside (), [], an object or an interpolation, newlines are insignificant. */
    private groupDepth: number;

    constructor(
        private readonly tokens: Token[],
        private readonly lexer: Lexer,
        private readonly text: string,
        groupDepth = 0,
    ) {
        this.groupDepth = groupDepth;
    }

    private peekRaw(): Token {
        return this.tokens[this.pos];
    }

    private peek(): Token {
        if (this.groupDepth > 0) {
            while (this.tokens[this.pos].type === 'newline') this.pos += 1;
        }
        return this.tokens[this.pos];
    }

    private next(): Token {
        const token = this.peek();
        if (token.type !== 'eof') this.pos += 1;
        return token;
    }

    private isPunct(value: string): boolean {
        const token = this.peek();
        return token.type === 'punct' && token.value === value;
    }

    private describe(token: Token): string {
        if (token.type === 'eof') return 'end of file';
        if (token.type === 'newline') return 'newline';
        if (token.type === 'template') return 'string';
        return JSON.stringify(token.value);
    }

    private fail(token: Token, expected: string): never {
        throw this.lexer.error(
            `expected ${expected}, found ${this.describe(token)}`,
            token.start,
        );
    }

    private expectPunct(value: string): Token {
        const token = this.next();
        if (token.type !== 'punct' || token.value !== value) {
            this.fail(token, JSON.stringify(value));
        }
        return token;
    }

    private skipNewlines() {
        while (this.peekRaw().type === 'newline') this.pos += 1;
    }

    /** A body: attributes and blocks until `}` (nested) or end of file (top level). */
    parseBody(nested: boolean): HclBody {
        const saved = this.groupDepth;
        this.groupDepth = 0;
        const body: HclBody = { attributes: [], blocks: [] };
        for (;;) {
            this.skipNewlines();
            const token = this.peekRaw();
            if (token.type === 'eof') {
                if (nested) this.fail(token, '"}" closing the block');
                break;
            }
            if (nested && token.type === 'punct' && token.value === '}') break;
            if (token.type !== 'ident')
                this.fail(token, 'an attribute or block');
            this.pos += 1;
            const after = this.peekRaw();
            const line = this.lineOf(token.start);
            if (after.type === 'punct' && after.value === '=') {
                this.pos += 1;
                const expr = this.parseExpression();
                body.attributes.push({ name: token.value, expr, line });
            } else {
                const labels: string[] = [];
                for (;;) {
                    const label = this.peekRaw();
                    if (label.type === 'ident') {
                        labels.push(label.value);
                        this.pos += 1;
                    } else if (label.type === 'template') {
                        const parts = label.parts ?? [];
                        if (parts.some((p) => typeof p !== 'string')) {
                            throw this.lexer.error(
                                'block labels cannot interpolate',
                                label.start,
                            );
                        }
                        labels.push(parts.join(''));
                        this.pos += 1;
                    } else {
                        break;
                    }
                }
                const open = this.peekRaw();
                if (open.type !== 'punct' || open.value !== '{') {
                    this.fail(open, '"=" or "{"');
                }
                this.pos += 1;
                const blockBody = this.parseBody(true);
                this.expectPunct('}');
                body.blocks.push({
                    type: token.value,
                    labels,
                    body: blockBody,
                    line,
                });
            }
            const end = this.peekRaw();
            if (
                end.type !== 'newline' &&
                end.type !== 'eof' &&
                !(nested && end.type === 'punct' && end.value === '}')
            ) {
                this.fail(end, 'a newline');
            }
        }
        this.groupDepth = saved;
        return body;
    }

    private lineOf(offset: number): number {
        return this.text.slice(0, offset).split('\n').length;
    }

    parseExpression(): HclExpr {
        const condition = this.parseBinary(1);
        if (this.isPunct('?')) {
            this.next();
            const whenTrue = this.parseExpression();
            this.expectPunct(':');
            const whenFalse = this.parseExpression();
            return {
                kind: 'conditional',
                condition,
                whenTrue,
                whenFalse,
                start: condition.start,
                end: whenFalse.end,
            };
        }
        return condition;
    }

    private parseBinary(minPrecedence: number): HclExpr {
        let left = this.parseUnary();
        for (;;) {
            const token = this.peek();
            const precedence =
                token.type === 'punct'
                    ? BINARY_PRECEDENCE[token.value]
                    : undefined;
            if (precedence === undefined || precedence < minPrecedence)
                return left;
            this.next();
            const right = this.parseBinary(precedence + 1);
            left = {
                kind: 'binary',
                op: token.value,
                left,
                right,
                start: left.start,
                end: right.end,
            };
        }
    }

    private parseUnary(): HclExpr {
        const token = this.peek();
        if (
            token.type === 'punct' &&
            (token.value === '!' || token.value === '-')
        ) {
            this.next();
            const operand = this.parseUnary();
            return {
                kind: 'unary',
                op: token.value,
                operand,
                start: token.start,
                end: operand.end,
            };
        }
        return this.parsePostfix(this.parsePrimary());
    }

    private parsePostfix(base: HclExpr): HclExpr {
        let expr = base;
        for (;;) {
            // Postfix operators must follow without a newline outside groups.
            const token = this.groupDepth > 0 ? this.peek() : this.peekRaw();
            if (token.type === 'punct' && token.value === '.') {
                this.pos += 1;
                const name = this.next();
                if (name.type === 'ident') {
                    expr = {
                        kind: 'getattr',
                        target: expr,
                        name: name.value,
                        start: expr.start,
                        end: name.end,
                    };
                } else if (
                    name.type === 'number' &&
                    /^[0-9]+$/.test(name.value)
                ) {
                    // Legacy index syntax: `list.0`.
                    expr = {
                        kind: 'index',
                        target: expr,
                        key: {
                            kind: 'literal',
                            value: Number(name.value),
                            start: name.start,
                            end: name.end,
                        },
                        start: expr.start,
                        end: name.end,
                    };
                } else if (name.type === 'punct' && name.value === '*') {
                    throw this.lexer.error(
                        'splat expressions (.*) are not supported',
                        name.start,
                    );
                } else {
                    this.fail(name, 'an attribute name');
                }
            } else if (token.type === 'punct' && token.value === '[') {
                this.pos += 1;
                this.groupDepth += 1;
                if (this.isPunct('*')) {
                    throw this.lexer.error(
                        'splat expressions ([*]) are not supported',
                        this.peek().start,
                    );
                }
                const key = this.parseExpression();
                const close = this.expectPunct(']');
                this.groupDepth -= 1;
                expr = {
                    kind: 'index',
                    target: expr,
                    key,
                    start: expr.start,
                    end: close.end,
                };
            } else {
                return expr;
            }
        }
    }

    private parsePrimary(): HclExpr {
        const token = this.next();
        switch (token.type) {
            case 'number':
                return {
                    kind: 'literal',
                    value: Number(token.value),
                    start: token.start,
                    end: token.end,
                };
            case 'template':
                return {
                    kind: 'template',
                    parts: token.parts ?? [''],
                    start: token.start,
                    end: token.end,
                };
            case 'ident': {
                if (token.value === 'true' || token.value === 'false') {
                    return {
                        kind: 'literal',
                        value: token.value === 'true',
                        start: token.start,
                        end: token.end,
                    };
                }
                if (token.value === 'null') {
                    return {
                        kind: 'literal',
                        value: null,
                        start: token.start,
                        end: token.end,
                    };
                }
                const open = this.peekRaw();
                if (open.type === 'punct' && open.value === '(') {
                    return this.parseCall(token);
                }
                return {
                    kind: 'variable',
                    name: token.value,
                    start: token.start,
                    end: token.end,
                };
            }
            case 'punct':
                if (token.value === '(') {
                    this.groupDepth += 1;
                    const inner = this.parseExpression();
                    this.expectPunct(')');
                    this.groupDepth -= 1;
                    return inner;
                }
                if (token.value === '[') return this.parseTuple(token);
                if (token.value === '{') return this.parseObject(token);
                return this.fail(token, 'an expression');
            default:
                return this.fail(token, 'an expression');
        }
    }

    private parseCall(name: Token): HclExpr {
        this.pos += 1; // (
        this.groupDepth += 1;
        const args: HclExpr[] = [];
        let expandFinal = false;
        while (!this.isPunct(')')) {
            args.push(this.parseExpression());
            if (this.isPunct('...')) {
                this.next();
                expandFinal = true;
            }
            if (!this.isPunct(',')) break;
            this.next();
        }
        const close = this.expectPunct(')');
        this.groupDepth -= 1;
        return {
            kind: 'call',
            name: name.value,
            args,
            expandFinal,
            start: name.start,
            end: close.end,
        };
    }

    private isForKeyword(): boolean {
        const token = this.peek();
        if (token.type !== 'ident' || token.value !== 'for') return false;
        const after = this.tokens
            .slice(this.pos + 1)
            .find((t) => t.type !== 'newline');
        return after?.type === 'ident';
    }

    private parseForHeader(): {
        keyVar: string | undefined;
        valueVar: string;
        collection: HclExpr;
    } {
        this.next(); // for
        const first = this.next();
        if (first.type !== 'ident') this.fail(first, 'a variable name');
        let keyVar: string | undefined;
        let valueVar = first.value;
        if (this.isPunct(',')) {
            this.next();
            const second = this.next();
            if (second.type !== 'ident') this.fail(second, 'a variable name');
            keyVar = first.value;
            valueVar = second.value;
        }
        const inToken = this.next();
        if (inToken.type !== 'ident' || inToken.value !== 'in')
            this.fail(inToken, '"in"');
        const collection = this.parseExpression();
        this.expectPunct(':');
        return { keyVar, valueVar, collection };
    }

    private parseForCondition(): HclExpr | undefined {
        const token = this.peek();
        if (token.type === 'ident' && token.value === 'if') {
            this.next();
            return this.parseExpression();
        }
        return undefined;
    }

    private parseTuple(open: Token): HclExpr {
        this.groupDepth += 1;
        if (this.isForKeyword()) {
            const header = this.parseForHeader();
            const valueExpr = this.parseExpression();
            const condition = this.parseForCondition();
            const close = this.expectPunct(']');
            this.groupDepth -= 1;
            return {
                kind: 'for',
                ...header,
                keyExpr: undefined,
                valueExpr,
                condition,
                grouping: false,
                start: open.start,
                end: close.end,
            };
        }
        const items: HclExpr[] = [];
        while (!this.isPunct(']')) {
            items.push(this.parseExpression());
            if (!this.isPunct(',')) break;
            this.next();
        }
        const close = this.expectPunct(']');
        this.groupDepth -= 1;
        return { kind: 'tuple', items, start: open.start, end: close.end };
    }

    private parseObject(open: Token): HclExpr {
        this.groupDepth += 1;
        if (this.isForKeyword()) {
            const header = this.parseForHeader();
            const keyExpr = this.parseExpression();
            this.expectPunct('=>');
            const valueExpr = this.parseExpression();
            let grouping = false;
            if (this.isPunct('...')) {
                this.next();
                grouping = true;
            }
            const condition = this.parseForCondition();
            const close = this.expectPunct('}');
            this.groupDepth -= 1;
            return {
                kind: 'for',
                ...header,
                keyExpr,
                valueExpr,
                condition,
                grouping,
                start: open.start,
                end: close.end,
            };
        }
        const items: HclObjectItem[] = [];
        while (!this.isPunct('}')) {
            const keyToken = this.peek();
            let key: HclExpr;
            const afterKey = this.tokens
                .slice(this.pos + 1)
                .find((t) => t.type !== 'newline');
            if (
                keyToken.type === 'ident' &&
                afterKey?.type === 'punct' &&
                (afterKey.value === '=' || afterKey.value === ':')
            ) {
                // A bare identifier key is its name, not a variable reference.
                this.next();
                key = {
                    kind: 'template',
                    parts: [keyToken.value],
                    start: keyToken.start,
                    end: keyToken.end,
                };
            } else {
                key = this.parseExpression();
            }
            const separator = this.next();
            if (
                separator.type !== 'punct' ||
                (separator.value !== '=' && separator.value !== ':')
            ) {
                this.fail(separator, '"=" or ":"');
            }
            const value = this.parseExpression();
            items.push({ key, value });
            if (this.isPunct(',')) this.next();
        }
        const close = this.expectPunct('}');
        this.groupDepth -= 1;
        return { kind: 'object', items, start: open.start, end: close.end };
    }

    expectEnd() {
        const token = this.peek();
        if (token.type !== 'eof') this.fail(token, 'end of expression');
    }
}

/** An interpolation parser for `text`: each interpolation gets its own lexer and parser. */
const interpolationParser =
    (text: string, file: string | undefined): InterpolationParser =>
    (from, to) => {
        const lexer = new Lexer(
            text,
            file,
            from,
            to,
            interpolationParser(text, file),
        );
        // An interpolation is a group: newlines inside it don't end the expression.
        const parser = new Parser(lexer.tokenize(), lexer, text, 1);
        const expr = parser.parseExpression();
        parser.expectEnd();
        return expr;
    };

/**
 * Parses one HCL file. Throws an `HclSyntaxError` whose message starts with `<file>:<line>:<col>`
 * for anything that isn't valid HCL (an unterminated string or block, a stray token, ...).
 */
export const parseHcl = (text: string, file?: string): HclFile => {
    const lexer = new Lexer(
        text,
        file,
        0,
        text.length,
        interpolationParser(text, file),
    );
    const parser = new Parser(lexer.tokenize(), lexer, text);
    return { file, text, body: parser.parseBody(false) };
};

// ------------------------------------------------------------------------------- evaluation

/** A value Terraform knows only at apply time (or the importer can't compute): kept symbolic. */
export class HclUnknown {
    constructor(
        /** The source text of the expression, e.g. `local.slack_webhooks.alerts`. */
        readonly text: string,
        /** Why it is unknown, for warnings. */
        readonly reason: string,
    ) {}
}

export type HclValue =
    | null
    | boolean
    | number
    | string
    | HclUnknown
    | HclValue[]
    | { [key: string]: HclValue };

export const isHclUnknown = (value: unknown): value is HclUnknown =>
    value instanceof HclUnknown;

export const isHclObject = (
    value: unknown,
): value is { [key: string]: HclValue } =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof HclUnknown);

/** Whether a value holds an unknown anywhere inside it. */
export const hclHasUnknown = (value: HclValue): boolean => {
    if (isHclUnknown(value)) return true;
    if (Array.isArray(value)) return value.some(hclHasUnknown);
    if (isHclObject(value)) return Object.values(value).some(hclHasUnknown);
    return false;
};

/** One step of a reference: an attribute name or an index key. */
export type HclStep = string | number;

export type HclScope = {
    /** Variables in scope (`each`, a dynamic block's iterator, `for` variables). */
    variables?: Record<string, HclValue>;
    /**
     * Resolves a reference whose root is not a variable (`local.x`, `grafana_folder.this["A"].uid`,
     * `data.x.y.z`): `root` and every step after it, with index keys evaluated. Returns
     * `undefined` when it can't, and the reference stays an `HclUnknown`.
     */
    resolve?: (root: string, steps: HclStep[]) => HclValue | undefined;
};

/** Applies attribute and index steps to a value; a missing key or an unknown gives unknown. */
export const traverseHclValue = (
    value: HclValue,
    steps: HclStep[],
    text: string,
): HclValue => {
    let current = value;
    for (const step of steps) {
        if (isHclUnknown(current)) return new HclUnknown(text, current.reason);
        if (Array.isArray(current) && typeof step === 'number') {
            if (step < 0 || step >= current.length || !Number.isInteger(step)) {
                return new HclUnknown(text, `index ${step} is out of range`);
            }
            current = current[step];
        } else if (isHclObject(current) && String(step) in current) {
            current = current[String(step)];
        } else {
            return new HclUnknown(
                text,
                `${JSON.stringify(String(step))} is not defined`,
            );
        }
    }
    return current;
};

const typeName = (value: HclValue): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'list';
    if (isHclObject(value)) return 'object';
    return typeof value;
};

const toHclString = (value: HclValue): string | undefined => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return undefined;
};

const toHclNumber = (value: HclValue): number | undefined => {
    if (typeof value === 'number') return value;
    if (
        typeof value === 'string' &&
        value.trim() !== '' &&
        !Number.isNaN(Number(value))
    ) {
        return Number(value);
    }
    return undefined;
};

const hclEquals = (a: HclValue, b: HclValue): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

/** JSON for `jsonencode`: unknowns become null (their value is unknowable here). */
const toJson = (value: HclValue): unknown => {
    if (isHclUnknown(value)) return null;
    if (Array.isArray(value)) return value.map(toJson);
    if (isHclObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, toJson(v)]),
        );
    }
    return value;
};

const fromJson = (value: unknown): HclValue => {
    if (Array.isArray(value)) return value.map(fromJson);
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, fromJson(v)]),
        );
    }
    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    return null;
};

/** Map keys in Terraform's iteration order (lexical). */
const sortedKeys = (value: { [key: string]: HclValue }) =>
    Object.keys(value).sort();

const toCollection = (value: HclValue): HclValue[] | undefined => {
    if (Array.isArray(value)) return value;
    if (isHclObject(value)) return sortedKeys(value).map((k) => value[k]);
    return undefined;
};

const dedupe = (values: HclValue[]) => {
    const seen = new Set<string>();
    return values.filter((v) => {
        const key = JSON.stringify(v);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

type HclFunction = (args: HclValue[], text: string) => HclValue;

const unknownArgs = (args: HclValue[]) => args.find(isHclUnknown);

const strict =
    (
        fn: (args: HclValue[], text: string) => HclValue | undefined,
        name: string,
    ): HclFunction =>
    (args, text) => {
        const unknown = unknownArgs(args);
        if (unknown) return new HclUnknown(text, unknown.reason);
        const result = fn(args, text);
        return result === undefined
            ? new HclUnknown(
                  text,
                  `invalid arguments to ${name}(${args.map(typeName).join(', ')})`,
              )
            : result;
    };

const FUNCTIONS: Record<string, HclFunction> = {
    jsonencode: (args) =>
        args.length === 1 ? JSON.stringify(toJson(args[0])) : null,
    jsondecode: strict(([value]) => {
        if (typeof value !== 'string') return undefined;
        try {
            return fromJson(JSON.parse(value));
        } catch {
            return undefined;
        }
    }, 'jsondecode'),
    sensitive: ([value]) => value ?? null,
    nonsensitive: ([value]) => value ?? null,
    tostring: strict(
        ([value]) => (value === null ? null : toHclString(value)),
        'tostring',
    ),
    tonumber: strict(
        ([value]) => (value === null ? null : toHclNumber(value)),
        'tonumber',
    ),
    tobool: strict(([value]) => {
        if (typeof value === 'boolean' || value === null) return value;
        if (value === 'true' || value === 'false') return value === 'true';
        return undefined;
    }, 'tobool'),
    tolist: strict(([value]) => toCollection(value), 'tolist'),
    toset: strict(([value]) => {
        const list = toCollection(value);
        if (!list) return undefined;
        const unique = dedupe(list);
        // Terraform iterates a set of strings in lexical order.
        return unique.every((v) => typeof v === 'string')
            ? [...(unique as string[])].sort()
            : unique;
    }, 'toset'),
    tomap: strict(
        ([value]) => (isHclObject(value) ? value : undefined),
        'tomap',
    ),
    merge: (args, text) => {
        const unknown = unknownArgs(args);
        if (unknown) return new HclUnknown(text, unknown.reason);
        const out: { [key: string]: HclValue } = {};
        for (const arg of args) {
            if (arg === null) continue; // eslint-disable-line no-continue
            if (!isHclObject(arg)) {
                return new HclUnknown(
                    text,
                    `merge() takes objects, got ${typeName(arg)}`,
                );
            }
            Object.assign(out, arg);
        }
        return out;
    },
    concat: strict((args) => {
        const lists = args.map(toCollection);
        return lists.every((l) => l !== undefined)
            ? (lists as HclValue[][]).flat()
            : undefined;
    }, 'concat'),
    flatten: strict(([value]) => {
        const flat = (v: HclValue): HclValue[] =>
            Array.isArray(v) ? v.flatMap(flat) : [v];
        return Array.isArray(value) ? flat(value) : undefined;
    }, 'flatten'),
    distinct: strict(
        ([value]) => (Array.isArray(value) ? dedupe(value) : undefined),
        'distinct',
    ),
    length: strict(([value]) => {
        if (typeof value === 'string') return [...value].length;
        if (Array.isArray(value)) return value.length;
        if (isHclObject(value)) return Object.keys(value).length;
        return undefined;
    }, 'length'),
    contains: strict(([list, item]) => {
        const values = toCollection(list);
        return values ? values.some((v) => hclEquals(v, item)) : undefined;
    }, 'contains'),
    keys: strict(
        ([value]) => (isHclObject(value) ? sortedKeys(value) : undefined),
        'keys',
    ),
    values: strict(
        ([value]) => (isHclObject(value) ? toCollection(value) : undefined),
        'values',
    ),
    lookup: (args, text) => {
        const [map, key, fallback] = args;
        if (isHclUnknown(map) || isHclUnknown(key)) {
            return new HclUnknown(text, 'lookup() of an unknown value');
        }
        if (!isHclObject(map) || typeof key !== 'string') {
            return new HclUnknown(text, 'invalid arguments to lookup()');
        }
        if (key in map) return map[key];
        return fallback === undefined
            ? new HclUnknown(text, `${JSON.stringify(key)} is not defined`)
            : fallback;
    },
    coalesce: (args, text) => {
        for (const arg of args) {
            if (isHclUnknown(arg)) return new HclUnknown(text, arg.reason);
            if (arg !== null && arg !== '') return arg;
        }
        return new HclUnknown(text, 'coalesce() has no non-null argument');
    },
    try: (args, text) =>
        args.find((arg) => !hclHasUnknown(arg)) ??
        new HclUnknown(text, 'no try() argument is known'),
    can: (args) => args.length === 1 && !hclHasUnknown(args[0]),
    lower: strict(
        ([s]) => (typeof s === 'string' ? s.toLowerCase() : undefined),
        'lower',
    ),
    upper: strict(
        ([s]) => (typeof s === 'string' ? s.toUpperCase() : undefined),
        'upper',
    ),
    title: strict(
        ([s]) =>
            typeof s === 'string'
                ? s.replace(/\b\w/g, (c) => c.toUpperCase())
                : undefined,
        'title',
    ),
    trimspace: strict(
        ([s]) => (typeof s === 'string' ? s.trim() : undefined),
        'trimspace',
    ),
    join: strict(([sep, list]) => {
        const values = toCollection(list);
        if (typeof sep !== 'string' || !values) return undefined;
        const strings = values.map(toHclString);
        return strings.every((s) => s !== undefined)
            ? strings.join(sep)
            : undefined;
    }, 'join'),
    split: strict(
        ([sep, s]) =>
            typeof sep === 'string' && typeof s === 'string'
                ? s.split(sep)
                : undefined,
        'split',
    ),
    replace: strict(([s, search, replacement]) => {
        if (
            typeof s !== 'string' ||
            typeof search !== 'string' ||
            typeof replacement !== 'string'
        ) {
            return undefined;
        }
        const regex = /^\/(.*)\/$/.exec(search);
        if (regex) {
            try {
                return s.replace(
                    new RegExp(regex[1], 'g'),
                    replacement.replace(/\$\{(\d+)\}/g, '$$$1'),
                );
            } catch {
                return undefined;
            }
        }
        return s.split(search).join(replacement);
    }, 'replace'),
    format: strict(([spec, ...rest]) => {
        if (typeof spec !== 'string') return undefined;
        let index = 0;
        let ok = true;
        const out = spec.replace(/%([%sdvqf])/g, (_m, verb: string) => {
            if (verb === '%') return '%';
            const arg = rest[index];
            index += 1;
            const text = arg === undefined ? undefined : toHclString(arg);
            if (text === undefined) {
                ok = false;
                return '';
            }
            return verb === 'q' ? JSON.stringify(text) : text;
        });
        return ok ? out : undefined;
    }, 'format'),
    abs: strict(
        ([n]) => (typeof n === 'number' ? Math.abs(n) : undefined),
        'abs',
    ),
    max: strict(
        (args) =>
            args.every((a) => typeof a === 'number')
                ? Math.max(...(args as number[]))
                : undefined,
        'max',
    ),
    min: strict(
        (args) =>
            args.every((a) => typeof a === 'number')
                ? Math.min(...(args as number[]))
                : undefined,
        'min',
    ),
    floor: strict(
        ([n]) => (typeof n === 'number' ? Math.floor(n) : undefined),
        'floor',
    ),
    ceil: strict(
        ([n]) => (typeof n === 'number' ? Math.ceil(n) : undefined),
        'ceil',
    ),
};

/** The functions `evaluateHcl` knows; any other call is an `HclUnknown`. */
export const HCL_FUNCTIONS = Object.keys(FUNCTIONS).sort();

const binary = (
    op: string,
    left: HclValue,
    right: HclValue,
    text: string,
): HclValue => {
    if (op === '==' || op === '!=') {
        if (hclHasUnknown(left) || hclHasUnknown(right)) {
            return new HclUnknown(text, 'comparison with an unknown value');
        }
        return op === '==' ? hclEquals(left, right) : !hclEquals(left, right);
    }
    if (isHclUnknown(left)) return new HclUnknown(text, left.reason);
    if (isHclUnknown(right)) return new HclUnknown(text, right.reason);
    if (op === '&&' || op === '||') {
        if (typeof left !== 'boolean' || typeof right !== 'boolean') {
            return new HclUnknown(text, `${op} needs booleans`);
        }
        return op === '&&' ? left && right : left || right;
    }
    const a = toHclNumber(left);
    const b = toHclNumber(right);
    if (a === undefined || b === undefined) {
        return new HclUnknown(text, `${op} needs numbers`);
    }
    switch (op) {
        case '+':
            return a + b;
        case '-':
            return a - b;
        case '*':
            return a * b;
        case '/':
            return b === 0 ? new HclUnknown(text, 'division by zero') : a / b;
        case '%':
            return b === 0 ? new HclUnknown(text, 'modulo by zero') : a % b;
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
        default:
            return new HclUnknown(text, `unknown operator ${op}`);
    }
};

/**
 * Evaluates an expression parsed from `source` (the file's text, used for the symbolic text of
 * unknowns). Never throws.
 */
export const evaluateHcl = (
    expr: HclExpr,
    source: string,
    scope: HclScope = {},
): HclValue => {
    const text = (e: HclExpr) => source.slice(e.start, e.end);
    const evaluate = (
        e: HclExpr,
        variables: Record<string, HclValue>,
    ): HclValue => {
        switch (e.kind) {
            case 'literal':
                return e.value;
            case 'template': {
                // "${x}" alone keeps x's type, as in Terraform.
                if (e.parts.length === 1 && typeof e.parts[0] !== 'string') {
                    return evaluate(e.parts[0], variables);
                }
                let out = '';
                for (const part of e.parts) {
                    if (typeof part === 'string') {
                        out += part;
                    } else {
                        const value = evaluate(part, variables);
                        if (isHclUnknown(value))
                            return new HclUnknown(text(e), value.reason);
                        const s = toHclString(value);
                        if (s === undefined) {
                            return new HclUnknown(
                                text(e),
                                `cannot interpolate a ${typeName(value)}`,
                            );
                        }
                        out += s;
                    }
                }
                return out;
            }
            case 'tuple':
                return e.items.map((item) => evaluate(item, variables));
            case 'object': {
                const out: { [key: string]: HclValue } = {};
                for (const item of e.items) {
                    const key = evaluate(item.key, variables);
                    const name = isHclUnknown(key)
                        ? undefined
                        : toHclString(key);
                    if (name === undefined) {
                        return new HclUnknown(
                            text(e),
                            'an object key is unknown',
                        );
                    }
                    out[name] = evaluate(item.value, variables);
                }
                return out;
            }
            case 'variable':
            case 'getattr':
            case 'index': {
                // Unwind the traversal to its root.
                const steps: HclStep[] = [];
                let node: HclExpr = e;
                while (node.kind === 'getattr' || node.kind === 'index') {
                    if (node.kind === 'getattr') {
                        steps.unshift(node.name);
                    } else {
                        const key = evaluate(node.key, variables);
                        if (isHclUnknown(key))
                            return new HclUnknown(text(e), key.reason);
                        if (
                            typeof key !== 'string' &&
                            typeof key !== 'number'
                        ) {
                            return new HclUnknown(
                                text(e),
                                `cannot index with a ${typeName(key)}`,
                            );
                        }
                        steps.unshift(key);
                    }
                    node = node.target;
                }
                if (node.kind !== 'variable') {
                    return traverseHclValue(
                        evaluate(node, variables),
                        steps,
                        text(e),
                    );
                }
                if (node.name in variables) {
                    return traverseHclValue(
                        variables[node.name],
                        steps,
                        text(e),
                    );
                }
                const resolved = scope.resolve?.(node.name, steps);
                return resolved === undefined
                    ? new HclUnknown(
                          text(e),
                          `${text(e)} is not known to the importer`,
                      )
                    : resolved;
            }
            case 'call': {
                let args = e.args.map((arg) => evaluate(arg, variables));
                if (e.expandFinal && args.length > 0) {
                    const last = args[args.length - 1];
                    if (!Array.isArray(last)) {
                        return new HclUnknown(
                            text(e),
                            'the expanded argument is not a list',
                        );
                    }
                    args = [...args.slice(0, -1), ...last];
                }
                const fn = FUNCTIONS[e.name];
                return fn
                    ? fn(args, text(e))
                    : new HclUnknown(
                          text(e),
                          `the function ${e.name}() is not supported`,
                      );
            }
            case 'unary': {
                const operand = evaluate(e.operand, variables);
                if (isHclUnknown(operand))
                    return new HclUnknown(text(e), operand.reason);
                if (e.op === '!') {
                    return typeof operand === 'boolean'
                        ? !operand
                        : new HclUnknown(text(e), '! needs a boolean');
                }
                const n = toHclNumber(operand);
                return n === undefined
                    ? new HclUnknown(text(e), '- needs a number')
                    : -n;
            }
            case 'binary': {
                const left = evaluate(e.left, variables);
                // Short-circuit like Terraform does for known booleans.
                if (e.op === '&&' && left === false) return false;
                if (e.op === '||' && left === true) return true;
                return binary(
                    e.op,
                    left,
                    evaluate(e.right, variables),
                    text(e),
                );
            }
            case 'conditional': {
                const condition = evaluate(e.condition, variables);
                if (typeof condition !== 'boolean') {
                    return new HclUnknown(
                        text(e),
                        isHclUnknown(condition)
                            ? condition.reason
                            : 'the condition is not a boolean',
                    );
                }
                return evaluate(
                    condition ? e.whenTrue : e.whenFalse,
                    variables,
                );
            }
            case 'for': {
                const collection = evaluate(e.collection, variables);
                if (isHclUnknown(collection))
                    return new HclUnknown(text(e), collection.reason);
                let entries: [HclValue, HclValue][];
                if (Array.isArray(collection)) {
                    entries = collection.map((v, i) => [i, v]);
                } else if (isHclObject(collection)) {
                    entries = sortedKeys(collection).map((k) => [
                        k,
                        collection[k],
                    ]);
                } else {
                    return new HclUnknown(
                        text(e),
                        `cannot iterate over a ${typeName(collection)}`,
                    );
                }
                const listOut: HclValue[] = [];
                const objectOut: { [key: string]: HclValue } = {};
                for (const [k, v] of entries) {
                    const inner = { ...variables, [e.valueVar]: v };
                    if (e.keyVar !== undefined) inner[e.keyVar] = k;
                    if (e.condition) {
                        const keep = evaluate(e.condition, inner);
                        if (typeof keep !== 'boolean') {
                            return new HclUnknown(
                                text(e),
                                'a for condition is not a known boolean',
                            );
                        }
                        if (!keep) continue; // eslint-disable-line no-continue
                    }
                    const value = evaluate(e.valueExpr, inner);
                    if (e.keyExpr) {
                        const key = evaluate(e.keyExpr, inner);
                        const name = isHclUnknown(key)
                            ? undefined
                            : toHclString(key);
                        if (name === undefined) {
                            return new HclUnknown(
                                text(e),
                                'a for key is unknown',
                            );
                        }
                        if (e.grouping) {
                            const group = objectOut[name];
                            objectOut[name] = Array.isArray(group)
                                ? [...group, value]
                                : [value];
                        } else {
                            objectOut[name] = value;
                        }
                    } else {
                        listOut.push(value);
                    }
                }
                return e.keyExpr ? objectOut : listOut;
            }
            default:
                return new HclUnknown(text(e), 'unsupported expression');
        }
    };
    return evaluate(expr, scope.variables ?? {});
};

/** A body's attribute by name (the last one wins, as Terraform rejects duplicates anyway). */
export const getHclAttribute = (
    body: HclBody,
    name: string,
): HclAttribute | undefined =>
    [...body.attributes].reverse().find((a) => a.name === name);

/** A body's blocks of one type, in source order. */
export const getHclBlocks = (body: HclBody, type: string): HclBlock[] =>
    body.blocks.filter((b) => b.type === type);
