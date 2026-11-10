// Scene 2: the incident. The scene opens Pharmacy Ops overview in the baseline, waits on the scenario clock for the
// incident and refreshes the dashboard until the fill queue backlog crosses the threshold line at 100 and the
// "Current fill queue backlog" stat turns red.
//
// It never restarts the scenario clock: restart it first with the incident a few seconds out, e.g.
//   curl -X POST <scenario>/scenario/restart -H 'content-type: application/json' \
//        -d '{"incidentAfterSeconds": 20, "recoveryAfterSeconds": 900}'
// When the incident is more than MAX_WAIT_MS away, the scene fails at once and says so.
//
// The "Fill queue backlog" Tile is an ECharts line drawn as SVG: the series is a solid path and the threshold is a
// dashed path in #F2495C. SVG y grows downwards, so the line is over the threshold when one of its points has a
// smaller y than the threshold path.
// Key moment: the line above the dashed threshold and the stat in red.
import type { Locator, Page } from '@playwright/test';
import { beat, expect, getScenario, openDashboardFromList, QUERY_ERROR_TEXT, refreshDashboard, signIn, test, tile, waitForPhase } from './lib/scene';

const DASHBOARD = 'Pharmacy Ops overview';
const THRESHOLD = 100;
const MAX_WAIT_MS = 120_000;
/** Below this much time to the incident the scene skips its baseline check (no time to refresh). */
const BASELINE_MIN_MS = 8_000;

test.describe.configure({ timeout: 240_000 });

type Crossing = { thresholdY: number | null; peakY: number | null; points: number };

/** Where the series' highest point and the threshold line are in the time series Tile's SVG. */
const crossing = (series: Locator): Promise<Crossing> =>
    series.evaluate((el) => {
        let thresholdY: number | null = null;
        let peakY: number | null = null;
        let points = 0;
        for (const p of Array.from(el.querySelectorAll('svg path'))) {
            const d = p.getAttribute('d') ?? '';
            const stroke = (p.getAttribute('stroke') ?? '').toUpperCase();
            if (stroke === '#F2495C' && p.getAttribute('stroke-dasharray')) {
                const m = d.match(/^M\s*[\d.]+\s+([\d.]+)/);
                if (m) thresholdY = Number(m[1]);
            } else if (/^#[0-9A-F]{6}$/.test(stroke) && !p.getAttribute('stroke-dasharray') && /L/.test(d)) {
                // the series line: "M x y L x y L ..." (point symbols are arcs and have no L)
                const ys = Array.from(d.matchAll(/[ML]\s*[\d.]+\s+([\d.]+)/g), (m) => Number(m[1]));
                if (ys.length > points) {
                    points = ys.length;
                    peakY = Math.min(...ys);
                }
            }
        }
        return { thresholdY, peakY, points };
    });

const isOver = (c: Crossing) => c.thresholdY !== null && c.peakY !== null && c.peakY < c.thresholdY;

type Stat = { value: number | null; red: boolean };

/** The big number of the stat Tile and whether it is drawn in red. */
const statOf = (stat: Locator): Promise<Stat> =>
    stat.evaluate((el) => {
        const text = Array.from(el.querySelectorAll('*')).find(
            (e) => e.children.length === 0 && /^\s*[\d,.]+\s*$/.test(e.textContent ?? ''),
        ) as HTMLElement | undefined;
        if (!text) return { value: null, red: false };
        const m = getComputedStyle(text).color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const red = !!m && Number(m[1]) >= 180 && Number(m[2]) <= 120 && Number(m[3]) <= 130;
        return { value: Number((text.textContent ?? '').replace(/,/g, '')), red };
    });

/** Refresh the dashboard and wait for both Tiles to show data again. */
async function refreshed(page: Page, stat: Locator, series: Locator): Promise<void> {
    await refreshDashboard(page);
    await expect(stat).toContainText(/\d/);
    await expect(series.locator('svg path[stroke-dasharray]').first()).toBeAttached();
}

test('02-incident: wait on the scenario clock for the incident; the backlog crosses the threshold and the stat turns red', async ({
    page,
    scene,
    stack,
}) => {
    const start = await getScenario(stack);
    expect(start.phase, 'the scene starts before the recovery (restart the scenario clock first)').not.toBe('recovered');

    await signIn(page, stack);
    await openDashboardFromList(page, stack, DASHBOARD);
    const stat = tile(page, 'Current fill queue backlog');
    const series = tile(page, 'Fill queue backlog');
    await expect(stat, 'the stat Tile shows a number').toContainText(/\d/);
    await expect(series.locator('svg path[stroke-dasharray]').first(), 'the threshold line is drawn').toBeAttached();
    await expect(page.getByText(QUERY_ERROR_TEXT)).toHaveCount(0);

    // Baseline: under the threshold and not red (when there is time to show it before the incident).
    const before = await getScenario(stack);
    const toIncidentMs = new Date(before.incidentAt).getTime() - new Date(before.now).getTime();
    if (before.phase === 'baseline' && toIncidentMs > BASELINE_MIN_MS) {
        await expect
            .poll(
                async () => {
                    const [c, s] = [await crossing(series), await statOf(stat)];
                    if (!isOver(c) && s.value !== null && s.value < THRESHOLD && !s.red) return 'baseline';
                    await refreshed(page, stat, series);
                    return 'not yet';
                },
                { message: 'baseline: the line is under the threshold and the stat is not red', timeout: toIncidentMs - 3_000, intervals: [1_000] },
            )
            .toBe('baseline');
    } else {
        test.info().annotations.push({ type: 'baseline', description: `skipped: phase ${before.phase}, ${toIncidentMs} ms to the incident` });
    }
    await beat(page);

    // Wait on the scenario clock (not a fixed sleep), then refresh until the incident shows on the dashboard.
    const incident = await waitForPhase(stack, 'incident', MAX_WAIT_MS);
    expect(new Date(incident.now).getTime(), 'the scenario clock is past the incident start').toBeGreaterThanOrEqual(new Date(incident.incidentAt).getTime());
    await expect
        .poll(
            async () => {
                await refreshed(page, stat, series);
                await beat(page, 2_000);
                const [c, s] = [await crossing(series), await statOf(stat)];
                return isOver(c) && s.value !== null && s.value >= THRESHOLD && s.red;
            },
            { message: 'incident: the line crosses the threshold and the stat turns red', timeout: 90_000, intervals: [3_000] },
        )
        .toBe(true);

    const c = await crossing(series);
    expect(c.points, 'the line has samples').toBeGreaterThan(10);
    expect(c.peakY!, 'the line is above the dashed threshold line').toBeLessThan(c.thresholdY!);
    const s = await statOf(stat);
    expect(s.value!, `the stat is at or over ${THRESHOLD}`).toBeGreaterThanOrEqual(THRESHOLD);
    expect(s.red, 'the stat is red').toBe(true);
    await expect(tile(page, 'Queue status'), 'the fill queue is Backlogged').toContainText('Backlogged');
    await expect(page.getByText(QUERY_ERROR_TEXT)).toHaveCount(0);
    expect((await getScenario(stack)).phase, 'still in the incident').toBe('incident');

    // move off the refresh button so its "Last refreshed at" tooltip does not cover the header
    await page.mouse.move(960, 1_060);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await beat(page, 1_500);
    await scene.keyMoment(page);
    await beat(page);
});
