// Renders the JSON plan `platform_explain` returns (Postgres `EXPLAIN (FORMAT JSON)`,
// estimate-only) as the text `EXPLAIN` prints, so a plan can be read or downloaded as text.

/** One node of a Postgres JSON plan. Keys are the ones `EXPLAIN (FORMAT JSON)` writes. */
export type ExplainPlanNode = {
    'Node Type': string;
    Plans?: ExplainPlanNode[];
    [key: string]: unknown;
};

/**
 * The `platform_explain` plan: the JSON array Postgres returns, one element of it
 * (`{ Plan: ... }`), a bare plan node, or any of these as a JSON string.
 */
export type ExplainPlanInput =
    | string
    | Array<{ Plan: ExplainPlanNode }>
    | { Plan: ExplainPlanNode }
    | ExplainPlanNode;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlanNode = (value: unknown): value is ExplainPlanNode =>
    isRecord(value) && typeof value['Node Type'] === 'string';

const toRootNode = (input: unknown): ExplainPlanNode => {
    let value: unknown = input;
    if (typeof value === 'string') value = JSON.parse(value) as unknown;
    if (Array.isArray(value)) {
        const items: unknown[] = value;
        [value] = items;
    }
    if (isRecord(value) && 'Plan' in value) value = value.Plan;
    if (!isPlanNode(value)) {
        throw new Error('Not a Postgres JSON explain plan');
    }
    return value;
};

const text = (node: ExplainPlanNode, key: string): string | undefined => {
    const value = node[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
};

const num = (node: ExplainPlanNode, key: string): number | undefined => {
    const value = node[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
};

const AGGREGATE_NAMES: Record<string, string> = {
    Plain: 'Aggregate',
    Sorted: 'GroupAggregate',
    Hashed: 'HashAggregate',
    Mixed: 'MixedAggregate',
};

// Join nodes print their join type the way Postgres does: "Hash Left Join",
// "Nested Loop Anti Join", while an inner join stays "Hash Join" / "Nested Loop".
const JOIN_STEMS: Record<string, string> = {
    'Hash Join': 'Hash',
    'Merge Join': 'Merge',
    'Nested Loop': 'Nested Loop',
};

const nodeName = (node: ExplainPlanNode): string => {
    const type = node['Node Type'];
    let name = type;
    if (type === 'Aggregate') {
        name = AGGREGATE_NAMES[text(node, 'Strategy') ?? ''] ?? type;
        const partial = text(node, 'Partial Mode');
        if (partial && partial !== 'Simple') name = `${partial} ${name}`;
    }
    const joinType = text(node, 'Join Type');
    if (type in JOIN_STEMS && joinType && joinType !== 'Inner') {
        name = `${JOIN_STEMS[type]} ${joinType} Join`;
    }
    if (node['Parallel Aware'] === true) name = `Parallel ${name}`;
    return name;
};

const nodeLabel = (node: ExplainPlanNode): string => {
    let label = nodeName(node);
    if (text(node, 'Scan Direction') === 'Backward') label += ' Backward';
    const index = text(node, 'Index Name');
    if (index) label += ` using ${index}`;
    const target =
        text(node, 'Relation Name') ??
        text(node, 'Function Name') ??
        text(node, 'CTE Name') ??
        text(node, 'Tuplestore Name');
    if (target) {
        label += ` on ${target}`;
        const alias = text(node, 'Alias');
        if (alias && alias !== target) label += ` ${alias}`;
    }
    const startup = num(node, 'Startup Cost');
    const total = num(node, 'Total Cost');
    const rows = num(node, 'Plan Rows');
    const width = num(node, 'Plan Width');
    if (
        startup !== undefined &&
        total !== undefined &&
        rows !== undefined &&
        width !== undefined
    ) {
        label += `  (cost=${startup.toFixed(2)}..${total.toFixed(
            2,
        )} rows=${rows.toFixed(0)} width=${width.toFixed(0)})`;
    }
    return label;
};

// Detail lines Postgres prints under a node, in its order.
const DETAIL_KEYS = [
    'Group Key',
    'Sort Key',
    'Hash Cond',
    'Merge Cond',
    'Join Filter',
    'Index Cond',
    'Recheck Cond',
    'One-Time Filter',
    'Filter',
] as const;

const detailLines = (node: ExplainPlanNode): string[] =>
    DETAIL_KEYS.flatMap((key) => {
        const value = node[key];
        if (typeof value === 'string' && value !== '') {
            return [`${key}: ${value}`];
        }
        if (Array.isArray(value) && value.length > 0) {
            return [`${key}: ${value.map(String).join(', ')}`];
        }
        return [];
    });

const spaces = (indent: number): string => ' '.repeat(indent * 2);

// Mirrors explain.c's text layout: a child line is "->  " at the parent's detail
// indent, and the child's own details and children sit three levels further in.
const renderNode = (
    node: ExplainPlanNode,
    startIndent: number,
    isRoot: boolean,
    lines: string[],
): void => {
    let indent = startIndent;
    const subplanName = text(node, 'Subplan Name');
    if (subplanName) {
        lines.push(`${spaces(indent)}${subplanName}`);
        indent += 1;
    }
    if (isRoot) {
        lines.push(nodeLabel(node));
    } else {
        lines.push(`${spaces(indent)}->  ${nodeLabel(node)}`);
        indent += 2;
    }
    indent += 1;
    detailLines(node).forEach((line) => lines.push(`${spaces(indent)}${line}`));
    (node.Plans ?? []).forEach((child) =>
        renderNode(child, indent, false, lines),
    );
};

/**
 * Renders a `platform_explain` JSON plan as Postgres-style `EXPLAIN` text, e.g.
 * `Seq Scan on orders  (cost=0.00..1.04 rows=4 width=40)`, with child nodes on
 * indented `->` lines. Accepts the plan array, one `{ Plan }` element, a bare plan
 * node, or any of these as a JSON string. Throws when the input is not a plan.
 */
export const formatExplainPlanAsText = (plan: ExplainPlanInput): string => {
    const lines: string[] = [];
    renderNode(toRootNode(plan), 0, true, lines);
    return lines.join('\n');
};
