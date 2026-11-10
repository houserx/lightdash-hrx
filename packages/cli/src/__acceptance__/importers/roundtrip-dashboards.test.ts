/* eslint-disable */
// @ts-nocheck
// imp-roundtrip-dashboards: importing all 32 fixture dashboards in one run succeeds with no
// crash, and every emitted file validates against the schemas the upload path uses
// (chart-as-code, dashboard-as-code, lightdash.config.yml); no chart has broken SQL and every
// tile references a chart that exists.
import { expectValidChart, expectValidDashboard, fixtureDashboards, validateProjectConfig } from './support';
import { expectSoundSql, importAllDashboards } from './roundtripsupport';

let run: any;
beforeAll(async () => {
    run = await importAllDashboards();
});
afterAll(() => run?.cleanup());

describe('all fixture dashboards', () => {
    it('imports every dashboard', () => {
        expect(fixtureDashboards()).toHaveLength(32);
        expect(run.dashboards()).toHaveLength(32);
        expect(run.charts().length).toBeGreaterThan(250);
    });

    it('emits only valid documents', () => {
        for (const { doc, file } of run.dashboards()) {
            expectValidDashboard(doc);
            for (const tile of doc.tiles.filter((t) => t.type === 'sql_chart')) {
                expect(run.chartBySlug(tile.properties.chartSlug), `${file} ${tile.properties.chartSlug}`).toBeDefined();
            }
        }
        for (const { doc } of run.charts()) expectValidChart(doc);
        if (run.exists('lightdash.config.yml')) {
            const { valid, errors } = validateProjectConfig(run.projectConfig());
            expect(errors).toBe('');
            expect(valid).toBe(true);
        }
    });

    it('writes no broken SQL', () => {
        for (const { doc, file } of run.charts()) expectSoundSql(doc.sql, file);
    });

    it('writes a report per dashboard', () => {
        for (const { doc } of run.dashboards()) expect(run.exists(`reports/${doc.slug}/IMPORT-REPORT.md`)).toBe(true);
    });
});
