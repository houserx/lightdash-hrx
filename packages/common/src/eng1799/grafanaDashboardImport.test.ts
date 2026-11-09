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
