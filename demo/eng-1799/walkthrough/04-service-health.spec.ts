// Scene 4: service health. The scene opens the Service health dashboard during the incident, filters the
// fill-service log stream to its error lines (the Tile's "Filter lines" box, `level=error`), then turns to the
// "Slow trace waterfall" Tile (the pinned example trace, the dashboard's `trace_id` parameter default) and opens the
// slow shipping-label-api span's detail drawer.
//
// It never restarts the scenario clock: restart it first with the incident a few seconds out (or already started),
// e.g.
//   curl -X POST <scenario>/scenario/restart -H 'content-type: application/json' \
//        -d '{"incidentAfterSeconds": -150, "recoveryAfterSeconds": 900}'
// When the incident is more than MAX_WAIT_MS away, the scene fails at once and says so.
//
// Key moment: the waterfall with the shipping-label-api span's drawer open (service, duration, attributes).
import { beat, expect, getScenario, openDashboardFromList, QUERY_ERROR_TEXT, signIn, test, tile, waitForPhase } from './lib/scene';

const DASHBOARD = 'Service health';
const LOGS_TILE = 'Fill service logs';
const WATERFALL_TILE = 'Slow trace waterfall';
const SLOW_SERVICE = 'shipping-label-api';
/** The shipping-label-api SERVER span of the fill-service "ship fill" trace (stack/tempo.ts). */
const SLOW_SPAN = 'POST /v1/labels';
const MAX_WAIT_MS = 120_000;

test.describe.configure({ timeout: 300_000 });

test('04-service-health: the log stream filtered to errors, then the trace waterfall with the slow span opened', async ({
    page,
    scene,
    stack,
}) => {
    const start = await getScenario(stack);
    expect(start.phase, 'the scene starts before the recovery (restart the scenario clock first)').not.toBe('recovered');
    // The error lines and the slow trace belong to the incident: wait on the scenario clock, not a fixed sleep.
    await waitForPhase(stack, 'incident', MAX_WAIT_MS);

    await signIn(page, stack);
    await openDashboardFromList(page, stack, DASHBOARD);

    // The log stream: every line of the last 30 minutes, newest first, with error rows among them.
    const logs = tile(page, LOGS_TILE);
    await logs.scrollIntoViewIfNeeded();
    const rows = logs.getByTestId('log-stream-row');
    await expect(rows.first(), 'the log stream shows lines').toBeVisible({ timeout: 60_000 });
    const count = logs.getByText(/^[\d,]+ of [\d,]+ lines$/);
    await expect(count, 'the log stream counts its lines').toBeVisible();
    const total = Number((await count.innerText()).match(/of ([\d,]+) lines/)![1].replace(/,/g, ''));
    expect(total, 'the log stream has lines').toBeGreaterThan(0);
    await expect(logs, 'the log stream Tile has no query error').not.toContainText(QUERY_ERROR_TEXT);
    await beat(page, 2_000);

    // Filter to the error lines, as a user types into the Tile's filter box.
    const filter = logs.getByRole('textbox', { name: 'Filter lines' });
    await filter.click();
    await filter.pressSequentially('level=error', { delay: 60 });
    await expect(count, 'the filter narrows the lines').not.toHaveText(`${total.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} lines`);
    const shown = Number((await count.innerText()).match(/^([\d,]+) of/)![1].replace(/,/g, ''));
    expect(shown, 'some lines are errors').toBeGreaterThan(0);
    expect(shown, 'fewer lines than before').toBeLessThan(total);
    const visible = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-level')));
    expect(visible.length, 'error rows are drawn').toBeGreaterThan(0);
    expect(new Set(visible), 'only error rows are left').toEqual(new Set(['error']));
    await expect(
        rows.getByTestId('log-stream-line').filter({ hasText: SLOW_SERVICE }).first(),
        `the incident's errors blame ${SLOW_SERVICE}`,
    ).toBeVisible();
    await beat(page, 2_500);

    // The trace waterfall: the pinned slow trace, the shipping-label-api span among its rows.
    const waterfall = tile(page, WATERFALL_TILE);
    await waterfall.scrollIntoViewIfNeeded();
    const spanRows = waterfall.getByTestId('trace-span-row');
    await expect(spanRows.first(), 'the waterfall shows spans').toBeVisible({ timeout: 60_000 });
    await expect(waterfall, 'the waterfall Tile has no query error').not.toContainText(QUERY_ERROR_TEXT);
    const slowRow = spanRows.filter({ hasText: SLOW_SERVICE }).filter({ has: page.getByRole('button', { name: `Show details of ${SLOW_SPAN}`, exact: true }) });
    await expect(slowRow, `the waterfall has the ${SLOW_SERVICE} span`).toHaveCount(1);
    await expect(slowRow, 'the slow span is nested under the fill-service call').not.toHaveAttribute('data-depth', '0');
    await slowRow.getByTestId('trace-span-bar').hover();
    await beat(page, 2_000);

    // Open the slow span: its drawer shows the service and a duration of seconds.
    await slowRow.getByRole('button', { name: `Show details of ${SLOW_SPAN}`, exact: true }).click();
    const drawer = page.getByRole('dialog').filter({ has: page.getByTestId('trace-span-drawer') });
    await expect(drawer, 'the span drawer opens').toBeVisible();
    await expect(drawer, 'the drawer names the span').toContainText(SLOW_SPAN);
    await expect(drawer, 'the drawer names the service').toContainText(SLOW_SERVICE);
    const durationText = await drawer.getByText('Duration', { exact: true }).locator('xpath=..').innerText();
    const seconds = durationText.match(/([\d.]+)\s?s\b/);
    expect(seconds, `the span takes seconds (${durationText.replace(/\s+/g, ' ')})`).not.toBeNull();
    expect(Number(seconds![1]), 'the shipping-label-api span is slow (2 s or more)').toBeGreaterThanOrEqual(2);
    await expect(drawer.getByTestId('trace-span-attributes'), 'the drawer lists the span attributes').toBeVisible();
    expect((await getScenario(stack)).phase, 'still in the incident').toBe('incident');

    await page.mouse.move(960, 1_060);
    await beat(page, 1_500);
    await scene.keyMoment(page);
    await beat(page);
});
