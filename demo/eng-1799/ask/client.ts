// ENG-1799 demo: the scripted MCP client behind `pnpm -F eng-1799-demo ask`. There is no model: a question is matched
// against a short list of scripted intents, and each intent names one telemetry-mcp tool call. The client signs in at
// the fake Okta as the demo user (stack.json `okta.issuer`, `demoUser.email`), speaks MCP over streamable HTTP to
// stack.json `mcp.url`, and turns the tool's table into {columns, rows} plus a one-sentence answer.
//
// The demo makes no network calls: every URL comes from .state/stack.json and is a 127.0.0.1 literal.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEMO_DIR = path.resolve(__dirname, '..');
export const STACK_JSON = path.join(DEMO_DIR, '.state', 'stack.json');

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 60_000;

export type AskStack = {
    demoUser: { email: string };
    mcp: { url: string };
    okta: { issuer: string };
};

export type AskResult = {
    question: string;
    tool: string;
    arguments: Record<string, unknown>;
    query: string;
    result: { columns: string[]; rows: unknown[][] };
    answer: string;
};

type Table = { columns: string[]; rows: Record<string, unknown>[]; rowCount?: number; truncated?: boolean };

type Intent = {
    /** Shown by `ask --list`. */
    example: string;
    matches: (q: string) => boolean;
    tool: string;
    arguments: Record<string, unknown>;
    /** The live query the tool runs (for query_promql, the PromQL expression). */
    query: string;
    answer: (table: Table) => string;
};

const BACKLOG_PROMQL = 'hrx_fill_queue_backlog{queue="fill"}';

const numberCell = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
};

const values = (table: Table) =>
    table.rows.map((r) => numberCell(r.value)).filter((n): n is number => n !== undefined);

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const INTENTS: Intent[] = [
    {
        example: 'How has the fill queue backlog changed over the last 15 minutes?',
        matches: (q) => /fill/.test(q) && /backlog|queue/.test(q) && /last|over|trend|changed|history|minutes|hour/.test(q),
        tool: 'query_promql',
        arguments: { query: BACKLOG_PROMQL, start: 'now-15m', end: 'now', step: '1m' },
        query: BACKLOG_PROMQL,
        answer: (t) => {
            const v = values(t);
            if (v.length === 0) return 'Prometheus returned no fill queue backlog samples for the last 15 minutes.';
            return (
                `Over the last 15 minutes the fill queue backlog ranged from ${fmt(Math.min(...v))} to ` +
                `${fmt(Math.max(...v))} jobs; the latest sample is ${fmt(v[v.length - 1])}.`
            );
        },
    },
    {
        example: 'What is the fill queue backlog right now?',
        matches: (q) => /fill/.test(q) && /backlog|queue/.test(q),
        tool: 'query_promql',
        arguments: { query: BACKLOG_PROMQL, at: 'now' },
        query: BACKLOG_PROMQL,
        answer: (t) => {
            const v = values(t);
            if (v.length === 0) return 'Prometheus returned no fill queue backlog sample right now.';
            const now = Math.max(...v);
            const state = now >= 100 ? 'above the alert threshold of 100' : 'below the alert threshold of 100';
            return `The fill queue backlog is ${fmt(now)} jobs right now, ${state}.`;
        },
    },
];

export const EXAMPLE_QUESTIONS = INTENTS.map((i) => i.example);

export function readAskStack(file = STACK_JSON): AskStack {
    let stack: AskStack;
    try {
        stack = JSON.parse(readFileSync(file, 'utf8')) as AskStack;
    } catch (err) {
        throw new Error(`cannot read ${file} (is the demo stack up? run demo/eng-1799/up.sh): ${(err as Error).message}`);
    }
    if (!stack.mcp?.url || !stack.okta?.issuer || !stack.demoUser?.email) {
        throw new Error(`${file} has no mcp.url, okta.issuer or demoUser.email`);
    }
    return stack;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { res, text: await res.text() };
}

async function signIn(stack: AskStack): Promise<string> {
    const { res, text } = await post(`${stack.okta.issuer}/v1/token`, { email: stack.demoUser.email });
    if (!res.ok) throw new Error(`fake Okta sign-in -> ${res.status}: ${text.slice(0, 300)}`);
    const token = (JSON.parse(text) as { access_token?: string }).access_token;
    if (!token) throw new Error('fake Okta returned no access_token');
    return token;
}

/** One MCP session over streamable HTTP (telemetry-mcp is stateless, so no session id comes back). */
class McpClient {
    private nextId = 1;

    private sessionId: string | undefined;

    constructor(
        private readonly url: string,
        private readonly token: string,
    ) {}

    private headers(): Record<string, string> {
        return {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': PROTOCOL_VERSION,
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        };
    }

    async notify(method: string, params: unknown = {}): Promise<void> {
        const { res, text } = await post(this.url, { jsonrpc: '2.0', method, params }, this.headers());
        if (!res.ok && res.status !== 202) throw new Error(`MCP ${method} -> ${res.status}: ${text.slice(0, 300)}`);
    }

    async request<T = any>(method: string, params: unknown = {}): Promise<T> {
        const id = this.nextId++;
        const { res, text } = await post(this.url, { jsonrpc: '2.0', id, method, params }, this.headers());
        if (!res.ok) throw new Error(`MCP ${method} -> ${res.status}: ${text.slice(0, 300)}`);
        this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
        const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
            ? text
                  .split('\n')
                  .filter((l) => l.startsWith('data:'))
                  .map((l) => JSON.parse(l.slice(5)))
            : [JSON.parse(text)];
        const reply = messages.find((m) => m?.id === id);
        if (!reply) throw new Error(`MCP ${method}: no reply with id ${id}`);
        if (reply.error) throw new Error(`MCP ${method} error: ${JSON.stringify(reply.error)}`);
        return reply.result as T;
    }

    async initialize(): Promise<void> {
        await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'eng-1799-demo-ask', version: '0.0.0' },
        });
        await this.notify('notifications/initialized');
    }
}

function toTable(result: any, tool: string): Table {
    const text = result?.content?.find((c: any) => c?.type === 'text')?.text;
    if (result?.isError) throw new Error(`${tool} failed: ${text ?? 'no message'}`);
    const table = (result?.structuredContent ?? (text ? JSON.parse(text) : undefined)) as Table | undefined;
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
        throw new Error(`${tool} returned no table`);
    }
    return table;
}

export async function ask(question: string, stack: AskStack = readAskStack()): Promise<AskResult> {
    const q = question.toLowerCase();
    const intent = INTENTS.find((i) => i.matches(q));
    if (!intent) {
        throw new Error(`the scripted client has no answer for that question; try one of:\n  ${EXAMPLE_QUESTIONS.join('\n  ')}`);
    }
    const client = new McpClient(`${stack.mcp.url}/mcp`, await signIn(stack));
    await client.initialize();
    const tools = await client.request<{ tools: { name: string }[] }>('tools/list');
    if (!tools.tools.some((t) => t.name === intent.tool)) {
        throw new Error(`telemetry-mcp offers the demo user no ${intent.tool} tool`);
    }
    const table = toTable(await client.request('tools/call', { name: intent.tool, arguments: intent.arguments }), intent.tool);
    return {
        question,
        tool: intent.tool,
        arguments: intent.arguments,
        query: intent.query,
        result: { columns: table.columns, rows: table.rows.map((r) => table.columns.map((c) => r[c])) },
        answer: intent.answer(table),
    };
}
