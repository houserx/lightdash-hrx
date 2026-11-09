/* eslint-disable */
// @ts-nocheck
// imp-dashboard-todo-tiles: a panel whose query can't be translated becomes a markdown TODO
// tile at the panel's position that says what to do, never a chart with broken SQL.
import { grafanaDashboard, importGrafanaDashboards, panel, tileByTitle } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Todo Tiles', [
            panel('timeseries', 'Works', { x: 0, y: 0, w: 12, h: 8 }),
            panel('table', 'Open pull requests', { x: 12, y: 0, w: 12, h: 8 }, {
                datasource: { type: 'grafana-github-datasource', uid: 'betb591q7ij28b' },
                targets: [
                    {
                        refId: 'A',
                        datasource: { type: 'grafana-github-datasource', uid: 'betb591q7ij28b' },
                        queryType: 'Pull_Requests',
                        owner: 'houserx',
                        repository: 'platform',
                    },
                ],
            }),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

describe('TODO tiles', () => {
    it('writes a markdown TODO tile instead of a chart', () => {
        expect(run.charts()).toHaveLength(1);
        const dashboard = run.dashboards()[0].doc;
        const todo = dashboard.tiles.find(
            (t) => t.type === 'markdown' && t.properties.title.includes('Open pull requests'),
        );
        expect(todo).toBeDefined();
        expect(todo.properties.content).toMatch(/TODO/);
        expect(todo.properties.content).toContain('Pull_Requests');
        expect(todo.properties.content).toMatch(/ops mart/i);
        const works = tileByTitle(dashboard, 'Works');
        expect(todo.y).toBe(works.y);
        expect(todo.x).toBe(18);
        expect(todo.w).toBe(18);
    });

    it('counts the TODO', () => {
        expect(run.summary().todos).toBe(1);
        expect(run.summary().warnings.byCode['no-ops-mart']).toBe(1);
    });
});
