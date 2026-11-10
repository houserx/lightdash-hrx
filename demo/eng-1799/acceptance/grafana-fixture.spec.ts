// demo-grafana-fixture. PROTECTED.
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dashboardTiles, DEMO, findDashboard, lightdashApi, NAMES, readStack } from './helpers/stack';

test('demo-grafana-fixture: one seeded dashboard comes from a synthetic Grafana dashboard JSON fixture', async () => {
    const dir = path.join(DEMO, 'seed', 'grafana');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length, 'a Grafana dashboard fixture in demo/eng-1799/seed/grafana/').toBeGreaterThan(0);

    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const dashboards = new Map<string, string[]>();
    for (const name of [NAMES.pharmacyOps, NAMES.serviceHealth, NAMES.platformDb]) {
        const d = await findDashboard(ctx, stack.lightdash.projectUuid, name);
        dashboards.set(name, (await dashboardTiles(ctx, stack.lightdash.projectUuid, d)).map((t) => t.title.toLowerCase()));
    }

    let matched = false;
    for (const f of files) {
        const text = readFileSync(path.join(dir, f), 'utf8');
        expect(text, `${f} is synthetic: no HouseRx hosts`).not.toMatch(/houserx\.(io|com)|amazonaws\.com/i);
        const g = JSON.parse(text);
        const panels: any[] = (g.dashboard ?? g).panels ?? [];
        const titles = panels.flatMap((p) => [p, ...(p.panels ?? [])]).filter((p) => p.type !== 'row' && p.title).map((p) => String(p.title).toLowerCase());
        expect(titles.length).toBeGreaterThanOrEqual(3);
        for (const tileTitles of dashboards.values()) {
            if (titles.every((t) => tileTitles.includes(t))) matched = true;
        }
    }
    expect(matched, 'every panel title of a fixture appears as a Tile title of one seeded dashboard').toBe(true);
});
