/* eslint-disable */
// @ts-nocheck
// imp-alert-notification-routes: the Grafana notification policy becomes the
// notification_routes tree, route for route (with --no-routing-fixes it is exactly today's
// tree: matchers, contact points, continue, grouping and timers, plus the `notify` routes that
// carry rules' notification_settings).
import { importFixtureAlerts, expectValidAlerting, routeAlert } from './support';

let run: any;
beforeAll(async () => {
    run = await importFixtureAlerts(['--no-routing-fixes']);
});
afterAll(() => run?.cleanup());

const slugOf = (name) => run.contactPoints().map((c) => c.doc).find((d) => d.name === name).slug;
const contactPoints = (labels) => routeAlert(run.routes(), labels).map((r) => r.contactPoint);

describe('notification routes', () => {
    it('keeps the root defaults', () => {
        const tree = run.routes();
        expectValidAlerting(tree);
        expect(tree).toMatchObject({
            version: 1,
            type: 'notification_routes',
            contactPoint: slugOf('slack-infra-alerts'),
            groupBy: ['...'],
            groupWait: '5s',
            groupInterval: '2m',
            repeatInterval: '1h',
        });
    });

    it('keeps every child route in order', () => {
        // Routes on the `notify` label carry rules' notification_settings (see
        // alerts-notification-settings); the rest are the Grafana policies.
        const routes = run.routes().routes.filter((r) => !(r.matchers ?? []).some((m) => m.label === 'notify'));
        expect(routes.map((r) => r.contactPoint)).toEqual([
            slugOf('test-alerts'),
            slugOf('slack-alerts'),
            slugOf('Grafana Alerts (incident.io)'),
            slugOf('slack-alerts-swat'),
            slugOf('slack-infra-alerts'),
        ]);
        expect(routes[1].matchers).toEqual([
            { label: 'team', operator: '=', value: 'engineering' },
            { label: 'channel', operator: '=', value: '#alerts' },
        ]);
        expect(routes.map((r) => r.continue === true)).toEqual([true, true, true, true, false]);
        expect(routes[1]).toMatchObject({ groupInterval: '1m', repeatInterval: '1m' });
        expect(routes[4]).toMatchObject({ repeatInterval: '1d' });
    });

    it('routes like Grafana does today', () => {
        expect(contactPoints({ team: 'infra' })).toEqual([slugOf('Grafana Alerts (incident.io)')]);
        expect(contactPoints({ team: 'engineering', channel: '#alerts' })).toEqual([slugOf('slack-alerts')]);
        expect(contactPoints({ team: 'Support' })).toEqual([slugOf('slack-infra-alerts')]);
        expect(contactPoints({ system: 'platform-environment-sweep' })).toEqual([slugOf('slack-infra-alerts')]);
    });
});
