// Scene 5: investigate. During the incident the scene opens the SQL Runner from the New menu, switches it to
// Investigate mode (offered because the Operations Project's warehouse is the federation flavour), picks Prometheus,
// writes an ad hoc PromQL query for the fill queue backlog, runs it and shows the time series, then saves it with
// "Save as chart". Lightdash opens the new SQL chart, whose SQL calls promql(...), and runs it.
//
// The generated SQL takes Investigate's time range through the reserved `${ld.parameters.__from}`, `__to` and
// `__interval` parameters. A SQL chart opened on its own (not on a dashboard) gets no time range, so Lightdash
// refuses those references ("Missing values for SQL parameter(s)"). Before saving, the scene therefore edits the SQL
// box: the query gets its own window, as the seeded hrx_fill_queue_backlog virtual view does, keeps the readable
// columns (the `labels` struct shows as "[object Object]" in a table) and lists the newest rows first.
//
// It never restarts the scenario clock: restart it first with the incident a few seconds out (or already started),
// e.g.
//   curl -X POST <scenario>/scenario/restart -H 'content-type: application/json' \
//        -d '{"incidentAfterSeconds": -150, "recoveryAfterSeconds": 900}'
// When the incident is more than MAX_WAIT_MS away, the scene fails at once and says so.
//
// Each run saves one more chart, named with the run's time so runs never collide.
//
// Key moment: the saved chart open for editing in the SQL Runner, its promql() SQL and rows.
import { beat, expect, getScenario, QUERY_ERROR_TEXT, signIn, test, waitForPhase } from './lib/scene';

/** The queue series of the fake Prometheus (stack/prometheus.ts); the fill queue is the one that backs up. */
const PROMQL = 'max by (queue) (hrx_fill_queue_backlog{job="fill-service"})';
/** The window the saved chart runs over on its own (it has no Dashboard Time Range to take one from). */
const OWN_WINDOW = "now() - INTERVAL '1 hour', now(), '15s'";
const MAX_WAIT_MS = 120_000;

test.describe.configure({ timeout: 300_000 });

test('05-investigate: an ad hoc PromQL query in Investigate, run and saved as a chart', async ({ page, scene, stack }) => {
    const start = await getScenario(stack);
    expect(start.phase, 'the scene starts before the recovery (restart the scenario clock first)').not.toBe('recovered');
    // The backed-up fill queue belongs to the incident: wait on the scenario clock, not a fixed sleep.
    await waitForPhase(stack, 'incident', MAX_WAIT_MS);

    await signIn(page, stack);
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/home`);

    // New -> Query using SQL runner, as a user starts an ad hoc query.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: /Query using SQL runner/ }).click();
    await page.waitForURL(/\/sql-runner$/);

    // Investigate is a mode of the SQL Runner on a federation project.
    const mode = page.getByRole('radiogroup', { name: 'SQL Runner mode' });
    await expect(mode, 'the SQL Runner offers Investigate on the federation project').toBeVisible();
    await beat(page);
    await page.getByText('Investigate', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Investigate' }), 'the SQL Runner is in Investigate mode').toBeChecked();
    await expect(page.getByRole('button', { name: 'Save as chart' }), 'nothing to save before there is a query').toBeDisabled();
    await beat(page);

    // Prometheus, then the PromQL query typed as a user would; the SQL box shows the generated promql() SQL.
    await page.getByText('Prometheus', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Prometheus' })).toBeChecked();
    const promql = page.getByRole('textbox', { name: 'PromQL' });
    await promql.click();
    await promql.pressSequentially(PROMQL, { delay: 35 });
    const sqlBox = page.getByRole('textbox', { name: 'SQL', exact: true });
    await expect(sqlBox, 'the SQL box calls promql()').toHaveValue(/^SELECT \* FROM promql\('max by \(queue\)/);
    await beat(page, 1_500);

    // Run it over Investigate's time range: a time series per queue.
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const result = page.getByTestId('investigate-result');
    const series = result.getByTestId('investigate-timeseries');
    await expect(series, 'the query draws a time series').toBeVisible({ timeout: 60_000 });
    await expect(result, 'the query ran without an error').not.toContainText(QUERY_ERROR_TEXT);
    await expect(result).not.toContainText('Query failed');
    await expect(series, 'one line per queue (fill, pack, ship)').toHaveAttribute('data-series-count', '3');
    await beat(page, 2_500);

    // Give the query its own window, so the saved chart runs without a Dashboard Time Range, and run it again.
    const generated = await sqlBox.inputValue();
    const reserved = '${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}';
    expect(generated, 'the generated SQL takes the reserved time parameters').toContain(reserved);
    const sql = `${generated.replace('SELECT *', 'SELECT "timestamp", "value", "series"').replace(reserved, OWN_WINDOW)} ORDER BY "timestamp" DESC`;
    await sqlBox.fill(sql);
    await expect(sqlBox).toHaveValue(sql);
    await beat(page, 1_500);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    // Without the labels column Investigate lists the rows in a table, newest first.
    const table = result.getByTestId('investigate-table');
    await expect(table, 'the edited query lists its rows').toBeVisible({ timeout: 60_000 });
    await expect(result).not.toContainText('Query failed');
    await expect(table.getByRole('cell', { name: '{queue="fill"}', exact: true }).first(), 'the fill queue is among the rows').toBeVisible();
    await table.scrollIntoViewIfNeeded();
    await beat(page, 2_000);

    // Save as chart under a name of this run.
    const chartName = `Fill queue backlog by queue (Investigate ${new Date().toISOString().slice(11, 19)} UTC)`;
    await page.getByRole('button', { name: 'Save as chart' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save as chart' });
    await expect(dialog, 'the Save as chart dialog opens').toBeVisible();
    await dialog.getByRole('textbox', { name: 'Chart name' }).pressSequentially(chartName, { delay: 25 });
    await beat(page);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Lightdash opens the new SQL chart.
    await page.waitForURL(/\/sql-runner\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByText('Success! SQL chart created'), 'Lightdash confirms the new chart').toBeVisible();
    await expect(page.getByText(chartName, { exact: true }).first(), 'the chart opens under its name').toBeVisible();
    const slug = new URL(page.url()).pathname.split('/').pop()!;
    const saved = await page.evaluate(
        async ({ projectUuid, slug: s }) => {
            const res = await fetch(`/api/v1/projects/${projectUuid}/sqlRunner/saved/slug/${s}`);
            return (await res.json()).results as { name: string; sql: string };
        },
        { projectUuid: stack.lightdash.projectUuid, slug },
    );
    expect(saved.name, 'the saved chart has the chosen name').toBe(chartName);
    expect(saved.sql, 'the saved chart keeps the Investigate SQL').toBe(sql);
    expect(saved.sql, 'the saved chart calls promql()').toMatch(/\bpromql\s*\(/);
    // The chart runs on its own: the Results tab lists the promql() rows, no error.
    const main = page.getByRole('main');
    await main.getByText('Results', { exact: true }).click();
    await expect(main.getByRole('cell', { name: '{queue="fill"}', exact: true }).first(), 'the chart lists the fill queue rows').toBeVisible({
        timeout: 60_000,
    });
    await expect(main.getByRole('columnheader', { name: 'series', exact: true }), 'the chart shows the chosen columns').toBeVisible();
    await expect(main, 'the chart runs without an error').not.toContainText(/Unexpected error|Missing values for SQL parameter/);
    await beat(page, 2_500);

    // Edit chart opens it in the SQL Runner: its SQL calls promql().
    await page.getByRole('button', { name: 'Edit chart' }).click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true }), 'the chart is open for editing').toBeVisible();
    await expect(page.getByRole('cell', { name: '{queue="fill"}', exact: true }).first(), 'the chart runs in the SQL Runner').toBeVisible({
        timeout: 60_000,
    });
    await beat(page);
    await page.getByText('SQL', { exact: true }).click();
    const editor = page.locator('.monaco-editor .view-lines');
    await expect(editor, 'the chart SQL calls promql()').toContainText('promql(', { timeout: 30_000 });
    await expect(editor, 'the chart SQL keeps its own window').toContainText("INTERVAL '1 hour'");
    await expect(page.getByText(/Unexpected error|Missing values for SQL parameter/), 'the chart runs in the SQL Runner too').toHaveCount(0);
    expect((await getScenario(stack)).phase, 'still in the incident').toBe('incident');

    await page.mouse.move(960, 1_060);
    await beat(page, 2_000);
    await scene.keyMoment(page);
    await beat(page);
});
