import { routeAlert, type NotificationRoute } from '../alerting/routingTree';
import {
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
        });
        expect(md).toContain('--no-routing-fixes');
        expect(md).toContain('No route is unreachable');
    });
});
