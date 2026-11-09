// Scene 6: an AI question through telemetry-mcp. There is no model: the question goes to the demo's scripted MCP
// client (ask/client.ts, the same code as `pnpm -F eng-1799-demo ask`), which signs in at the fake Okta as the demo
// user and calls the matching telemetry-mcp tool (query_promql on the fill queue backlog). The scene records a small
// local page (lib/ask-page.ts): it types the question, presses Ask, and the page shows the tool call, the live query,
// the result table and the answer. The client's JSON result is saved as out/scenes/06-ai-question/answer.json.
//
// It never restarts the scenario clock: restart it first with the incident a few seconds out (or already started),
// e.g.
//   curl -X POST <scenario>/scenario/restart -H 'content-type: application/json' \
//        -d '{"incidentAfterSeconds": -120, "recoveryAfterSeconds": 900}'
// The scene waits until the incident has run for INCIDENT_SETTLE_MS (the backlog has ramped above the threshold).
// When the incident is more than MAX_WAIT_MS away, the scene fails at once and says so.
//
// Key moment: the page with the question, the query_promql call, the result rows and the answer.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ask, type AskResult } from '../ask/client';
import { ASK_PAGE_HTML } from './lib/ask-page';
import { beat, expect, getScenario, test, waitForPhase } from './lib/scene';

const QUESTION = 'How has the fill queue backlog changed over the last 15 minutes?';
const TOOL = 'query_promql';
const METRIC = 'hrx_fill_queue_backlog';
const THRESHOLD = 100;
const MAX_WAIT_MS = 120_000;
/** stack/prometheus.ts: from incidentAt+30s every fill backlog sample is at least 120. */
const INCIDENT_SETTLE_MS = 30_000;

test.describe.configure({ timeout: 300_000 });

test('06-ai-question: a question through the scripted MCP client, with the tool call, the query and the result shown', async ({
    page,
    scene,
    stack,
}) => {
    const start = await getScenario(stack);
    expect(start.phase, 'the scene starts before the recovery (restart the scenario clock first)').not.toBe('recovered');
    const incident = await waitForPhase(stack, 'incident', MAX_WAIT_MS);
    const settledAt = new Date(incident.incidentAt).getTime() + INCIDENT_SETTLE_MS;
    await expect
        .poll(async () => new Date((await getScenario(stack)).now).getTime() >= settledAt, {
            message: 'the incident has run long enough for the backlog to ramp up',
            timeout: INCIDENT_SETTLE_MS + 15_000,
            intervals: [500],
        })
        .toBe(true);

    // The page's Ask button calls the scripted MCP client in Node.
    let answer: AskResult | undefined;
    await page.exposeFunction('askTelemetry', async (question: string) => {
        answer = await ask(question);
        return answer;
    });
    await page.setContent(ASK_PAGE_HTML);
    await expect(page.getByRole('heading', { name: 'Ask telemetry-mcp' })).toBeVisible();
    await expect(page.getByTestId('ask-tool'), 'no tool call before the question is asked').toBeHidden();
    await expect(page.getByTestId('ask-answer'), 'no answer before the question is asked').toBeHidden();
    await beat(page, 1_500);

    const input = page.getByTestId('ask-question');
    await input.click();
    await input.pressSequentially(QUESTION, { delay: 35 });
    await beat(page, 800);
    await page.getByTestId('ask-submit').click();

    // The tool call and its live query appear first.
    await expect(page.getByTestId('ask-tool'), 'the client called the telemetry-mcp tool').toHaveText(TOOL, { timeout: 60_000 });
    await expect(page.getByTestId('ask-error'), 'the call did not fail').toBeHidden();
    await expect(page.getByTestId('ask-query'), 'the live PromQL query is shown').toContainText(METRIC);
    await expect(page.getByTestId('ask-arguments'), 'the call asks for the last 15 minutes').toContainText('now-15m');
    expect(answer, 'the scripted client returned a result').toBeTruthy();
    const out = answer!;
    expect(out.question).toBe(QUESTION);
    expect(out.tool).toBe(TOOL);
    expect(out.query).toContain(METRIC);
    await beat(page, 1_000);

    // Then the result table, one row per sample.
    const rows = page.getByTestId('ask-result-row');
    expect(out.result.rows.length, 'the query returned samples').toBeGreaterThan(0);
    await expect(rows, 'every sample is a row').toHaveCount(out.result.rows.length);
    await expect(page.getByTestId('ask-row-count')).toContainText(`${out.result.rows.length} rows`);
    const valueAt = out.result.columns.indexOf('value');
    expect(valueAt, 'the result has a value column').toBeGreaterThanOrEqual(0);
    const values = out.result.rows.map((r) => Number(r[valueAt])).filter(Number.isFinite);
    expect(values.length, 'the samples are numbers').toBe(out.result.rows.length);
    expect(Math.max(...values), 'the incident pushed the backlog over the threshold').toBeGreaterThanOrEqual(THRESHOLD);
    await expect(rows.first().locator('td.hot'), 'the newest sample is over the threshold, in red').toHaveCount(1);
    await beat(page, 1_000);

    // Last, the one-sentence answer.
    await expect(page.getByTestId('ask-answer'), 'the answer is shown').toHaveText(out.answer);
    expect(out.answer, 'the answer names the latest sample').toMatch(/latest sample is \d/);
    expect((await getScenario(stack)).phase, 'still in the incident').toBe('incident');

    writeFileSync(path.join(scene.dir, 'answer.json'), `${JSON.stringify(out, null, 2)}\n`);
    await beat(page, 1_500);
    await scene.keyMoment(page);
    await beat(page);
});
