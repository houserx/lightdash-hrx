/* eslint-disable */
// @ts-nocheck
// imp-roundtrip-warning-snapshot: the warnings from importing every fixture (32 dashboards, the
// full rule set, the Perses dashboards) are counted per code, and the counts are recorded in
// docs/eng-1799/importers-warning-counts.json; this test fails when the importers' output drifts
// from the recorded counts. Shape:
//   {"grafana-dashboard": {"total": n, "todos": n, "byCode": {...}},
//    "grafana-alerts": {...}, "perses-dashboard": {...}}
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './support';
import { importAllAlerts, importAllDashboards, importAllPerses } from './roundtripsupport';

const SNAPSHOT = path.join(REPO_ROOT, 'docs/eng-1799/importers-warning-counts.json');

const counts = (summary) => ({ total: summary.warnings.total, todos: summary.todos, byCode: summary.warnings.byCode });

let actual: any = {};
beforeAll(async () => {
    for (const [key, importer] of [
        ['grafana-dashboard', importAllDashboards],
        ['grafana-alerts', importAllAlerts],
        ['perses-dashboard', importAllPerses],
    ]) {
        const run = await importer();
        try {
            expect(run.result.code).toBe(0);
            actual[key] = counts(run.summary());
        } finally {
            await run.cleanup();
        }
    }
}, 300_000);

describe('warning counts snapshot', () => {
    it('is recorded', () => {
        expect(existsSync(SNAPSHOT)).toBe(true);
    });

    it('matches the importers today', () => {
        const recorded = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
        expect(actual).toEqual(recorded);
    });

    it('counts consistently', () => {
        for (const value of Object.values(actual)) {
            const sum = Object.values(value.byCode).reduce((a, b) => a + b, 0);
            expect(sum).toBe(value.total);
            for (const code of Object.keys(value.byCode)) expect(code).toMatch(/^[a-z0-9-]+$/);
        }
        // Today's dashboards use annotations and GitHub/Sentry panels, and some rules have no summary.
        expect(actual['grafana-dashboard'].byCode['annotations-unsupported']).toBeGreaterThan(0);
        expect(actual['grafana-alerts'].total).toBeGreaterThan(0);
    });
});
