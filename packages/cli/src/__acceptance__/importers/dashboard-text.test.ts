/* eslint-disable */
// @ts-nocheck
// imp-dashboard-text: Grafana text panels become markdown tiles: markdown is copied, html is
// copied as-is, and code mode is wrapped in a fenced code block with its language.
import { grafanaDashboard, importGrafanaDashboards, panel } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Text Panels', [
            panel('text', 'Read me', { x: 0, y: 0, w: 12, h: 6 }, {
                targets: [],
                options: { mode: 'markdown', content: '## On call\n\n- Check the [runbook](https://example.test/runbook) first.' },
            }),
            panel('text', 'Html note', { x: 12, y: 0, w: 12, h: 6 }, {
                targets: [],
                options: { mode: 'html', content: '<p>Owned by <b>Platform</b></p>' },
            }),
            panel('text', 'Query example', { x: 0, y: 6, w: 24, h: 6 }, {
                targets: [],
                options: { mode: 'code', code: { language: 'sql' }, content: 'SELECT 1;' },
            }),
            // Old schema: content at the panel root.
            { id: 9, type: 'text', title: 'Legacy text', gridPos: { x: 0, y: 12, w: 24, h: 4 }, mode: 'markdown', content: 'Legacy *content*' },
        ]),
    ]);
});
afterAll(() => run?.cleanup());

const markdown = (title) =>
    run.dashboards()[0].doc.tiles.find((t) => t.type === 'markdown' && t.properties.title === title);

describe('text panels', () => {
    it('become markdown tiles and no charts', () => {
        expect(run.charts()).toHaveLength(0);
        expect(run.dashboards()[0].doc.tiles.filter((t) => t.type === 'markdown')).toHaveLength(4);
    });

    it('copy markdown and html content', () => {
        expect(markdown('Read me').properties.content).toBe(
            '## On call\n\n- Check the [runbook](https://example.test/runbook) first.',
        );
        expect(markdown('Html note').properties.content).toBe('<p>Owned by <b>Platform</b></p>');
        expect(markdown('Legacy text').properties.content).toBe('Legacy *content*');
    });

    it('fence code mode content with its language', () => {
        expect(markdown('Query example').properties.content).toBe('```sql\nSELECT 1;\n```');
    });
});
