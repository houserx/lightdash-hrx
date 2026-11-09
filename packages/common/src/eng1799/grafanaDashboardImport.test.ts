import {
    convertGrafanaDashboard,
    renderGrafanaImportReport,
    type GrafanaDashboardImportOptions,
} from './grafanaDashboardImport';

const options = (): GrafanaDashboardImportOptions => ({
    spaceSlug: 'grafana',
    takenDashboardSlugs: new Set<string>(),
    takenChartSlugs: new Set<string>(),
});

describe('renderGrafanaImportReport', () => {
    it('lists every warning with its code and panel, and every TODO', () => {
        const result = convertGrafanaDashboard(
            {
                dashboard: {
                    title: 'Report One',
                    panels: [
                        {
                            id: 1,
                            type: 'news',
                            title: 'Blog feed',
                            gridPos: { x: 0, y: 0, w: 12, h: 6 },
                        },
                        {
                            id: 2,
                            type: 'timeseries',
                            title: 'Elastic errors',
                            gridPos: { x: 12, y: 0, w: 12, h: 6 },
                            datasource: { type: 'elasticsearch', uid: 'es' },
                            targets: [
                                {
                                    refId: 'A',
                                    datasource: {
                                        type: 'elasticsearch',
                                        uid: 'es',
                                    },
                                    query: 'status:500',
                                },
                            ],
                        },
                    ],
                },
            },
            options(),
        );
        const report = renderGrafanaImportReport(result);
        const codes = result.warnings.map((w) => w.code);
        expect(codes).toContain('panel-dropped');
        expect(codes).toContain('datasource-unsupported');
        expect(report).toContain('# Import report: Report One');
        expect(report).toContain(`${result.warnings.length} warnings, 1 TODO.`);
        expect(report).toMatch(/\| panel-dropped \| Blog feed \| /);
        expect(report).toMatch(
            /\| datasource-unsupported \| Elastic errors \| /,
        );
        expect(report).toMatch(/- \*\*Elastic errors\*\*: .*elasticsearch/);
        // One table row per warning.
        expect(
            report.split('\n').filter((l) => /^\| [a-z][a-z-]* \|/.test(l)),
        ).toHaveLength(result.warnings.length);
    });

    it('says there are no warnings or TODOs for a clean dashboard', () => {
        const result = convertGrafanaDashboard(
            { dashboard: { title: 'Report Two', panels: [] } },
            options(),
        );
        const report = renderGrafanaImportReport(result);
        expect(report).toContain('0 warnings, 0 TODOs.');
        expect(report).toContain('No warnings.');
        expect(report).toContain('No TODOs.');
    });

    it('keeps pipes and newlines from breaking the table, and lists a multi-target TODO', () => {
        const result = convertGrafanaDashboard(
            { dashboard: { title: 'Edge', panels: [] } },
            options(),
        );
        const report = renderGrafanaImportReport({
            ...result,
            warnings: [
                { code: 'panel-dropped', panel: 'A | B', message: 'one\ntwo' },
                { code: 'datasource-unresolved', message: 'dashboard level' },
            ],
            todos: [{ panel: 'Multi', text: 'TODO: first\nTODO: second' }],
        });
        expect(report).toContain('| panel-dropped | A \\| B | one two |');
        expect(report).toContain(
            '| datasource-unresolved |  | dashboard level |',
        );
        expect(report).toContain(
            '- **Multi**:\n  - TODO: first\n  - TODO: second',
        );
    });
});

describe('convertGrafanaDashboard over several dashboards', () => {
    const dashboard = (title: string) => ({
        dashboard: {
            title,
            panels: [
                {
                    id: 1,
                    type: 'timeseries',
                    title: 'Requests',
                    gridPos: { x: 0, y: 0, w: 24, h: 8 },
                    datasource: { type: 'prometheus', uid: 'prom' },
                    targets: [
                        {
                            refId: 'A',
                            expr: 'sum(rate(http_requests_total[5m]))',
                        },
                    ],
                },
            ],
        },
    });
    const importAll = (titles: string[]) => {
        const shared = options();
        return titles.map((title) =>
            convertGrafanaDashboard(dashboard(title), shared),
        );
    };

    it('gives same-titled dashboards and their charts unique slugs, even past a suffixed title', () => {
        const results = importAll([
            'Same Title',
            'Same Title',
            'Same Title 2',
            '!!!',
            '!!!',
        ]);
        expect(results.map((r) => r.dashboard.slug)).toEqual([
            'same-title',
            'same-title-2',
            'same-title-2-2',
            'grafana-dashboard',
            'grafana-dashboard-2',
        ]);
        const chartSlugs = results.flatMap((r) => r.charts.map((c) => c.slug));
        expect(chartSlugs).toHaveLength(5);
        expect(new Set(chartSlugs).size).toBe(5);
        results.forEach((r) => {
            const own = new Set(r.charts.map((c) => c.slug));
            r.dashboard.tiles
                .filter((t) => t.type === 'sql_chart')
                .forEach((t) =>
                    expect(own.has(String(t.properties.chartSlug))).toBe(true),
                );
        });
    });

    it('gives the same output on every run', () => {
        const titles = ['Same Title', 'Same Title', 'Another'];
        expect(JSON.stringify(importAll(titles))).toBe(
            JSON.stringify(importAll(titles)),
        );
    });
});
