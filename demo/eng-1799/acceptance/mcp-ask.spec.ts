// demo-mcp-ask. PROTECTED.
// `pnpm -F eng-1799-demo ask --json "<question>"` is a scripted MCP client (no real model): it signs in to the fake
// Okta as the demo user, calls telemetry-mcp tools and prints ONE JSON object:
//   {question, tool, arguments, query, result: {columns: string[], rows: unknown[][]}, answer}
import { expect, test } from '@playwright/test';
import { readStack, restartScenario, sh } from './helpers/stack';

const ask = (q: string) => {
    const r = sh('pnpm', ['--silent', '--fail-if-no-match', '-F', 'eng-1799-demo', 'ask', '--json', q], { timeoutMs: 120_000 });
    expect(r.status, `ask failed:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`).toBe(0);
    return JSON.parse(r.stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? r.stdout);
};

/** Cells that are numbers (or numeric strings) and not epoch timestamps. */
const numericCells = (rows: unknown[][]) =>
    rows
        .flat()
        .filter((c) => typeof c === 'number' || (typeof c === 'string' && /^-?\d+(\.\d+)?$/.test(c)))
        .map(Number)
        .filter((x) => Math.abs(x) < 1e9);

test('demo-mcp-ask: a scripted MCP client asks about the fill queue and gets the live answer through telemetry-mcp', async () => {
    const stack = readStack();
    await restartScenario(stack, -120, 900);

    const q = 'What is the fill queue backlog right now?';
    const out = ask(q);
    expect(out.question).toBe(q);
    expect(['query_promql', 'ask_data']).toContain(out.tool);
    expect(out.query).toContain('hrx_fill_queue_backlog');
    expect(Array.isArray(out.result.columns)).toBe(true);
    expect(out.result.rows.length).toBeGreaterThan(0);
    expect(Math.max(...numericCells(out.result.rows)), 'the incident backlog is in the result').toBeGreaterThanOrEqual(120);
    expect(String(out.answer)).toMatch(/\d/);

    await restartScenario(stack, 900, 1200);
    const calm = ask(q);
    expect(numericCells(calm.result.rows).length).toBeGreaterThan(0);
    expect(Math.max(...numericCells(calm.result.rows)), 'baseline backlog').toBeLessThanOrEqual(60);
});
