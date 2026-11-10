/* eslint-disable */
// @ts-nocheck
// imp-dashboard-links: panel links go into the chart tile's description (the saved SQL
// chart's description, shown on the tile), and dashboard links into the dashboard's
// description, so the destinations are not lost.
import { chartTiles, grafanaDashboard, importGrafanaDashboards, panel } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard(
            'Linked Things',
            [
                panel('timeseries', 'With links', { x: 0, y: 0, w: 24, h: 8 }, {
                    description: 'Requests per second.',
                    links: [
                        { title: 'Service SLOs', url: 'https://example.test/slos', targetBlank: true },
                        { title: 'Runbook', url: 'https://example.test/runbook' },
                    ],
                }),
                panel('timeseries', 'Field links', { x: 0, y: 8, w: 24, h: 8 }, {
                    fieldConfig: {
                        defaults: { links: [{ title: 'Trace search', url: 'https://example.test/traces?q=${__field.labels.route}' }] },
                        overrides: [],
                    },
                }),
            ],
            {
                description: 'Synthetic dashboard.',
                links: [
                    { title: 'Platform docs', type: 'link', url: 'https://example.test/docs' },
                    { title: 'Related', type: 'dashboards', tags: ['kubernetes-app'], asDropdown: true },
                ],
            },
        ),
    ]);
});
afterAll(() => run?.cleanup());

describe('links', () => {
    it('adds panel links to the chart description', () => {
        const dashboard = run.dashboards()[0].doc;
        const chart = chartTiles(run, dashboard).find((t) => t.tile.properties.title === 'With links').chart;
        expect(chart.description).toContain('Requests per second.');
        expect(chart.description).toContain('[Service SLOs](https://example.test/slos)');
        expect(chart.description).toContain('[Runbook](https://example.test/runbook)');
        const field = chartTiles(run, dashboard).find((t) => t.tile.properties.title === 'Field links').chart;
        expect(field.description).toContain('Trace search');
    });

    it('adds dashboard links to the dashboard description', () => {
        const dashboard = run.dashboards()[0].doc;
        expect(dashboard.description).toContain('Synthetic dashboard.');
        expect(dashboard.description).toContain('[Platform docs](https://example.test/docs)');
        // A tag-based dashboard list can't be followed; it is named, and reported.
        expect(dashboard.description).toContain('Related');
        expect(run.report(dashboard.slug)).toContain('kubernetes-app');
    });
});
