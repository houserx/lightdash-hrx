// Message templates (ENG-1799). A TypeScript implementation of the Go
// `text/template` subset that Grafana notification templates use, so the
// templates in today's Grafana render the same in Lightdash:
// - `{{ .A.B }}` fields and map keys; a missing key renders '' (Grafana's
//   label/annotation maps are map[string]string, whose zero value is '');
// - `{{ $x := ... }}` / `{{ $x = ... }}` variables, with `$` the template's
//   data;
// - `if` / `else if` / `else`, `with`, `range` (with `$i, $e :=`, `else`,
//   `break`, `continue`), `define` / `template` / `block`, comments;
// - pipelines with `|` and parentheses, `{{-` / `-}}` whitespace trims;
// - the Go built-in functions (and, or, not, len, index, slice, eq, ne, lt,
//   le, gt, ge, print, printf, println, html, js, urlquery) plus Grafana's
//   simple string helpers (toUpper, toLower, title, trimSpace, join,
//   stringSlice, safeHtml);
// - `.Alerts.Firing` / `.Alerts.Resolved` (Grafana's methods on its alert
//   list) filter a list by each alert's `Status`.
// Parse errors and execution errors (such as an unknown template name)
// throw an AlertTemplateError whose message names the problem.
import {
    fieldOf,
    formatValue,
    isRecord,
    TEMPLATE_FUNCTIONS,
    truth,
} from './templateFunctions';
import {
    parseTemplateSource,
    type ControlNode,
    type Node,
    type Operand,
    type Pipeline,
} from './templateParser';
import { AlertTemplateError, type AlertTemplateOptions } from './templateTypes';

export * from './templateTypes';

const MAX_TEMPLATE_DEPTH = 100;
const MAIN_TEMPLATE_NAME = 'message';

type Variable = { name: string; value: unknown };

// Thrown by {{break}} / {{continue}} and caught by the enclosing range.
const BREAK = new Error('{{break}}');
const CONTINUE = new Error('{{continue}}');

const rangeEntries = (v: unknown): Array<[unknown, unknown]> => {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v.map((e, i) => [i, e]);
    if (isRecord(v)) {
        return Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]);
    }
    if (typeof v === 'number' && Number.isInteger(v)) {
        return Array.from({ length: Math.max(v, 0) }, (_e, i) => [i, i]);
    }
    throw new AlertTemplateError(`range can't iterate over ${formatValue(v)}`);
};

class Executor {
    private depth = 0;

    constructor(private readonly defines: Map<string, Node[]>) {}

    run(nodes: Node[], dot: unknown): string {
        const out: string[] = [];
        this.walk(nodes, dot, [{ name: '$', value: dot }], out);
        return out.join('');
    }

    private walk(nodes: Node[], dot: unknown, vars: Variable[], out: string[]) {
        for (const node of nodes) {
            switch (node.kind) {
                case 'text':
                    out.push(node.text);
                    break;
                case 'action': {
                    const value = this.evalPipeline(node.pipe, dot, vars);
                    if (!node.pipe.decl.length) out.push(formatValue(value));
                    break;
                }
                case 'if':
                case 'with': {
                    const mark = vars.length;
                    const value = this.evalPipeline(node.pipe, dot, vars);
                    if (truth(value)) {
                        this.walk(
                            node.list,
                            node.kind === 'with' ? value : dot,
                            vars,
                            out,
                        );
                    } else if (node.elseList) {
                        this.walk(node.elseList, dot, vars, out);
                    }
                    vars.splice(mark);
                    break;
                }
                case 'range':
                    this.walkRange(node, dot, vars, out);
                    break;
                case 'template':
                    this.walkTemplate(node.name, node.pipe, dot, vars, out);
                    break;
                case 'break':
                    throw BREAK;
                default:
                    throw CONTINUE;
            }
        }
    }

    private walkRange(
        node: ControlNode,
        dot: unknown,
        vars: Variable[],
        out: string[],
    ) {
        const mark = vars.length;
        const { decl, assign } = node.pipe;
        const entries = rangeEntries(
            this.evalPipeline({ ...node.pipe, decl: [] }, dot, vars),
        );
        if (!entries.length) {
            if (node.elseList) this.walk(node.elseList, dot, vars, out);
            vars.splice(mark);
            return;
        }
        for (const [key, element] of entries) {
            const values = decl.length === 2 ? [key, element] : [element];
            decl.forEach((name, i) => {
                if (assign) this.setVariable(vars, name, values[i]);
                else vars.push({ name, value: values[i] });
            });
            try {
                this.walk(node.list, element, vars, out);
            } catch (signal) {
                if (signal === BREAK) break;
                if (signal !== CONTINUE) throw signal;
            } finally {
                vars.splice(mark);
            }
        }
        vars.splice(mark);
    }

    private walkTemplate(
        name: string,
        pipe: Pipeline | undefined,
        dot: unknown,
        vars: Variable[],
        out: string[],
    ) {
        const body = this.defines.get(name);
        if (!body) {
            throw new AlertTemplateError(
                `template: no such template "${name}"`,
            );
        }
        if (this.depth >= MAX_TEMPLATE_DEPTH) {
            throw new AlertTemplateError(
                `template: exceeded maximum template depth (${MAX_TEMPLATE_DEPTH}) calling "${name}"`,
            );
        }
        const value = pipe ? this.evalPipeline(pipe, dot, vars) : undefined;
        this.depth += 1;
        try {
            this.walk(body, value, [{ name: '$', value }], out);
        } finally {
            this.depth -= 1;
        }
    }

    private evalPipeline(pipe: Pipeline, dot: unknown, vars: Variable[]) {
        let value: unknown;
        pipe.cmds.forEach((cmd, i) => {
            value = this.evalCommand(cmd, dot, vars, i > 0, value);
        });
        pipe.decl.forEach((name) => {
            if (pipe.assign) this.setVariable(vars, name, value);
            else vars.push({ name, value });
        });
        return value;
    }

    private evalCommand(
        [head, ...rest]: Operand[],
        dot: unknown,
        vars: Variable[],
        hasFinal: boolean,
        final: unknown,
    ): unknown {
        if (head.kind !== 'func') return this.evalOperand(head, dot, vars);
        const args = rest.map((o) => this.evalOperand(o, dot, vars));
        if (hasFinal) args.push(final);
        return TEMPLATE_FUNCTIONS[head.name](args);
    }

    private evalOperand(operand: Operand, dot: unknown, vars: Variable[]) {
        switch (operand.kind) {
            case 'dot':
                return dot;
            case 'literal':
                return operand.value;
            case 'func':
                return TEMPLATE_FUNCTIONS[operand.name]([]);
            case 'field':
                return operand.names.reduce(fieldOf, dot);
            case 'variable':
                return operand.names.reduce(
                    fieldOf,
                    this.variable(vars, operand.name).value,
                );
            default:
                return operand.names.reduce(
                    fieldOf,
                    this.evalPipeline(operand.pipe, dot, vars),
                );
        }
    }

    private variable(vars: Variable[], name: string): Variable {
        for (let i = vars.length - 1; i >= 0; i -= 1) {
            if (vars[i].name === name) return vars[i];
        }
        throw new AlertTemplateError(`undefined variable "${name}"`);
    }

    private setVariable(vars: Variable[], name: string, value: unknown) {
        this.variable(vars, name).value = value;
    }
}

// ---------------------------------------------------------------- API

/**
 * Renders a notification template (Go text/template syntax, as in Grafana)
 * against `data`, usually an {@link AlertTemplateData}. `options.templates`
 * holds extra template source whose `define`s can be called with
 * `{{ template "name" . }}`; defines in `template` itself override them.
 * Throws an AlertTemplateError on a parse error or an execution error such
 * as an unknown template name.
 */
export const renderAlertTemplate = (
    template: string,
    data: unknown,
    options: AlertTemplateOptions = {},
): string => {
    const defines = new Map<string, Node[]>();
    const extra =
        typeof options.templates === 'string'
            ? [options.templates]
            : (options.templates ?? []);
    extra.forEach((source, i) => {
        const name = extra.length > 1 ? `templates[${i}]` : 'templates';
        parseTemplateSource(source, name, defines);
    });
    const nodes = parseTemplateSource(template, MAIN_TEMPLATE_NAME, defines);
    return new Executor(defines).run(nodes, data);
};
