import { routeAlert, type NotificationRoute } from '../alerting/routingTree';
import {
    addSeverityRoutes,
    findUnhandledSeverities,
    fixUnreachableRoutes,
    renderGrafanaRoutingFixes,
} from './grafanaRoutingFixes';

const eq = (label: string, value: string) => ({
    label,
    operator: '=' as const,
    value,
});

const TREE: NotificationRoute = {
    contactPoint: 'default',
    routes: [
        {
            matchers: [
                { label: 'team', operator: '=~', value: 'infra|platform' },
            ],
            contactPoint: 'pager',
        },
        { matchers: [eq('team', 'platform')], contactPoint: 'slack-platform' },
        {
            matchers: [eq('severity', 'critical')],
            contactPoint: 'slack-alerts',
        },
    ],
};

const RULES: { name: string; labels: Record<string, string> }[] = [
    { name: 'Platform rule', labels: { team: 'platform' } },
    {
        name: 'Infra critical rule',
        labels: { team: 'infra', severity: 'critical' },
    },
    { name: 'Infra rule', labels: { team: 'infra' } },
];

const sent = (tree: NotificationRoute, labels: Record<string, string>) =>
    routeAlert(tree, labels).map((r) => r.contactPoint);

describe('fixUnreachableRoutes', () => {
    it('lists each shadowed route with its cause and rules', () => {
        const { unreachableRoutes } = fixUnreachableRoutes(TREE, RULES);
        expect(unreachableRoutes).toEqual([
            {
                route: {
                    path: [1],
                    matchers: [eq('team', 'platform')],
                    contactPoint: 'slack-platform',
                },
                shadowedBy: {
                    path: [0],
                    matchers: TREE.routes![0].matchers,
                    contactPoint: 'pager',
                },
                cause: 'matcher-order',
                rules: ['Platform rule'],
            },
            {
                route: {
                    path: [2],
                    matchers: [eq('severity', 'critical')],
                    contactPoint: 'slack-alerts',
                },
                shadowedBy: {
                    path: [0],
                    matchers: TREE.routes![0].matchers,
                    contactPoint: 'pager',
                },
                cause: 'missing-continue',
                rules: ['Infra critical rule'],
            },
        ]);
    });

    it('fixes the tree without changing the input or untouched alerts', () => {
        const before = JSON.stringify(TREE);
        const { fixed } = fixUnreachableRoutes(TREE, RULES);
        expect(JSON.stringify(TREE)).toBe(before);
        expect(sent(fixed, { team: 'platform' })).toEqual([
            'pager',
            'slack-platform',
        ]);
        expect(sent(fixed, { team: 'infra', severity: 'critical' })).toEqual([
            'pager',
            'slack-alerts',
        ]);
        expect(sent(fixed, { team: 'infra' })).toEqual(['pager']);
        expect(sent(fixed, { team: 'web' })).toEqual(['default']);
    });

    it('repeats until a fix exposes no further shadowed route', () => {
        const tree: NotificationRoute = {
            contactPoint: 'default',
            routes: [
                { matchers: [eq('a', '1')], contactPoint: 'x' },
                { matchers: [eq('b', '1')], contactPoint: 'y' },
                { matchers: [eq('c', '1')], contactPoint: 'z' },
            ],
        };
        const { fixed, unreachableRoutes } = fixUnreachableRoutes(tree, [
            { name: 'All', labels: { a: '1', b: '1', c: '1' } },
        ]);
        expect(sent(fixed, { a: '1', b: '1', c: '1' })).toEqual([
            'x',
            'y',
            'z',
        ]);
        expect(unreachableRoutes.map((u) => u.route.path)).toEqual([[1], [2]]);
    });

    it('checks nested routes only for the rules that reach their parent', () => {
        const tree: NotificationRoute = {
            contactPoint: 'default',
            routes: [
                {
                    matchers: [eq('team', 'infra')],
                    continue: true,
                    routes: [
                        {
                            matchers: [eq('env', 'prod')],
                            contactPoint: 'pager',
                        },
                        {
                            matchers: [eq('severity', 'critical')],
                            contactPoint: 'sms',
                        },
                    ],
                },
            ],
        };
        const { unreachableRoutes } = fixUnreachableRoutes(tree, [
            {
                name: 'Web',
                labels: { team: 'web', env: 'prod', severity: 'critical' },
            },
            {
                name: 'Infra',
                labels: { team: 'infra', env: 'prod', severity: 'critical' },
            },
        ]);
        expect(unreachableRoutes).toHaveLength(1);
        expect(unreachableRoutes[0].route.path).toEqual([0, 1]);
        expect(unreachableRoutes[0].rules).toEqual(['Infra']);
    });

    it('finds nothing when continue is already set', () => {
        const tree: NotificationRoute = {
            ...TREE,
            routes: TREE.routes!.map((r) => ({ ...r, continue: true })),
        };
        expect(fixUnreachableRoutes(tree, RULES).unreachableRoutes).toEqual([]);
    });
});

describe('renderGrafanaRoutingFixes', () => {
    it('names the routes, the rules and the fix', () => {
        const { unreachableRoutes } = fixUnreachableRoutes(TREE, RULES);
        const md = renderGrafanaRoutingFixes({
            applied: true,
            unreachableRoutes,
            unhandledSeverities: [],
        });
        expect(md).toMatch(/## Unreachable routes/);
        expect(md).toContain('team = platform');
        expect(md).toContain('severity = critical');
        expect(md).toContain('Platform rule');
        expect(md).toContain('Infra critical rule');
        expect(md).toContain('continue: true on route root.0');
        expect(md).toContain('team =~ infra\\|platform');
    });

    it('says when the fixes are not applied, and when there is nothing to fix', () => {
        const md = renderGrafanaRoutingFixes({
            applied: false,
            unreachableRoutes: [],
            unhandledSeverities: [],
        });
        expect(md).toContain('--no-routing-fixes');
        expect(md).toContain('No route is unreachable');
        expect(md).toContain('Every severity value');
    });

    it('lists unhandled severities with their fix or the decision they need', () => {
        const { unhandledSeverities } = addSeverityRoutes(
            TREE,
            [
                { value: '1', rules: ['Sev one'], contactPoint: 'pager' },
                { value: 'low', rules: ['Low'] },
            ],
            0,
        );
        const md = renderGrafanaRoutingFixes({
            applied: true,
            unreachableRoutes: [],
            unhandledSeverities,
        });
        expect(md).toMatch(/## Unhandled severities/);
        expect(md).toContain('`severity = 1`');
        expect(md).toContain(
            'severity route `severity = 1` -> pager (route root.0)',
        );
        expect(md).toContain('`severity = low`');
        expect(md).toContain('needs a decision');
    });
});

describe('findUnhandledSeverities', () => {
    const rules: { name: string; labels: Record<string, string> }[] = [
        { name: 'Critical', labels: { severity: 'critical' } },
        { name: 'Sev one', labels: { team: 'web', severity: '1' } },
        { name: 'Low', labels: { severity: 'low' } },
        { name: 'Low again', labels: { severity: 'low' } },
        { name: 'No severity', labels: { team: 'infra' } },
    ];

    it('lists the values no route matches on severity, with their rules', () => {
        expect(findUnhandledSeverities(TREE, rules)).toEqual([
            { value: '1', rules: ['Sev one'] },
            { value: 'low', rules: ['Low', 'Low again'] },
        ]);
    });

    it('counts nested routes and regex matchers as handling a value', () => {
        const tree: NotificationRoute = {
            contactPoint: 'default',
            routes: [
                {
                    matchers: [eq('team', 'web')],
                    routes: [
                        {
                            matchers: [
                                {
                                    label: 'severity',
                                    operator: '=~',
                                    value: '1|low',
                                },
                            ],
                            contactPoint: 'pager',
                        },
                    ],
                },
            ],
        };
        expect(findUnhandledSeverities(tree, rules)).toEqual([
            { value: 'critical', rules: ['Critical'] },
        ]);
    });
});

describe('addSeverityRoutes', () => {
    it('adds a continue route per decided value and leaves the input alone', () => {
        const before = JSON.stringify(TREE);
        const { fixed, unhandledSeverities } = addSeverityRoutes(
            TREE,
            [
                { value: 'low', rules: ['Low'] },
                { value: '1', rules: ['Sev one'], contactPoint: 'pager' },
            ],
            0,
        );
        expect(JSON.stringify(TREE)).toBe(before);
        expect(fixed.routes![0]).toEqual({
            matchers: [eq('severity', '1')],
            contactPoint: 'pager',
            continue: true,
        });
        expect(fixed.routes).toHaveLength(TREE.routes!.length + 1);
        expect(unhandledSeverities[0]).toEqual({
            value: 'low',
            rules: ['Low'],
        });
        expect(unhandledSeverities[1].route?.path).toEqual([0]);
        expect(sent(fixed, { team: 'platform', severity: '1' })).toEqual([
            'pager',
            'pager',
        ]);
        expect(sent(fixed, { team: 'web', severity: '1' })).toContain('pager');
    });
});
