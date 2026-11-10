import { routeAlert, type NotificationRoute } from '../alerting/routingTree';
import {
    addNotifyRoutes,
    addSeverityRoutes,
    addTeamRoutes,
    findDefaultOnlyRules,
    findTeamLabelFix,
    findUnhandledSeverities,
    findUnreachedContactPoints,
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
            unreachedContactPoints: [],
            defaultOnlyRules: [],
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
            unreachedContactPoints: [],
            defaultOnlyRules: [],
        });
        expect(md).toContain('--no-routing-fixes');
        expect(md).toContain('No route is unreachable');
        expect(md).toContain('Every severity value');
        expect(md).toContain('Every imported contact point');
        expect(md).toContain('Every imported rule reaches a route');
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
            unreachedContactPoints: [],
            defaultOnlyRules: [],
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

describe('unreached contact points', () => {
    const SLUGS = [
        'default',
        'pager',
        'slack-platform',
        'slack-alerts',
        'slack-sec',
        'sms',
    ];

    it('lists the contact points no route names, the root included, in order', () => {
        expect(findUnreachedContactPoints(TREE, SLUGS)).toEqual([
            'slack-sec',
            'sms',
        ]);
        expect(
            findUnreachedContactPoints({ contactPoint: 'default' }, [
                'default',
            ]),
        ).toEqual([]);
    });

    it('adds a continue notify route for each, so rules opt in and others route as before', () => {
        const before = JSON.stringify(TREE);
        const { fixed, unreachedContactPoints } = addNotifyRoutes(
            TREE,
            ['slack-sec', 'sms'],
            'notify',
            1,
        );
        expect(JSON.stringify(TREE)).toBe(before);
        expect(fixed.routes![1]).toEqual({
            matchers: [eq('notify', 'slack-sec')],
            contactPoint: 'slack-sec',
            continue: true,
        });
        expect(
            unreachedContactPoints.map((u) => [u.contactPoint, u.route.path]),
        ).toEqual([
            ['slack-sec', [1]],
            ['sms', [2]],
        ]);
        expect(sent(fixed, { notify: 'slack-sec' })).toEqual(['slack-sec']);
        expect(sent(fixed, { notify: 'sms', team: 'web' })).toEqual(['sms']);
        expect(sent(fixed, { team: 'infra' })).toEqual(['pager']);
        expect(sent(fixed, { team: 'web' })).toEqual(['default']);
    });

    it('renders them with their fix', () => {
        const { unreachedContactPoints } = addNotifyRoutes(
            TREE,
            ['slack-sec'],
            'notify',
            0,
        );
        const md = renderGrafanaRoutingFixes({
            applied: true,
            unreachableRoutes: [],
            unhandledSeverities: [],
            unreachedContactPoints,
            defaultOnlyRules: [],
        });
        expect(md).toMatch(/## Unreached contact points/);
        expect(md).toContain(
            '| `slack-sec` | route `notify = slack-sec` -> slack-sec (route root.0), continue: true |',
        );
    });
});

describe('default route only', () => {
    const POLICY: NotificationRoute = {
        contactPoint: 'default',
        routes: [
            {
                matchers: [eq('team', 'engineering'), eq('channel', '#alerts')],
                contactPoint: 'slack-alerts',
                continue: true,
            },
            {
                matchers: [eq('app', 'web')],
                routes: [
                    {
                        matchers: [eq('team', 'web'), eq('env', 'prod')],
                        contactPoint: 'slack-web',
                    },
                ],
            },
            { matchers: [eq('team', 'infra')], contactPoint: 'pager' },
        ],
    };
    const rule = (name: string, labels: Record<string, string>) => ({
        name,
        labels,
    });

    it('finds the rules that match no route', () => {
        const rules = [
            rule('pg_cron', { team: 'engineering', app: 'platform' }),
            rule('Support', { team: 'Support' }),
            rule('Unlabelled', {}),
            rule('Routed', { team: 'infra' }),
            rule('Web without team', { app: 'web' }),
        ];
        expect(findDefaultOnlyRules(POLICY, rules).map((r) => r.name)).toEqual([
            'pg_cron',
            'Support',
            'Unlabelled',
        ]);
        expect(
            findDefaultOnlyRules(
                {
                    contactPoint: 'default',
                    routes: [
                        {
                            matchers: [eq('alertname', 'Unlabelled')],
                            contactPoint: 'pager',
                        },
                    ],
                },
                rules,
            ).map((r) => r.name),
        ).not.toContain('Unlabelled');
    });

    it("adds the team route's missing equality labels, its ancestors' included", () => {
        const pgCron = findTeamLabelFix(
            POLICY,
            rule('pg_cron', { team: 'engineering', app: 'platform' }),
        );
        expect(pgCron).toEqual({
            addedLabels: { channel: '#alerts' },
            route: {
                path: [0],
                matchers: [eq('team', 'engineering'), eq('channel', '#alerts')],
                contactPoint: 'slack-alerts',
            },
        });
        expect(
            sent(POLICY, {
                team: 'engineering',
                app: 'platform',
                channel: '#alerts',
            }),
        ).toEqual(['slack-alerts']);
        expect(
            findTeamLabelFix(POLICY, rule('Web', { team: 'web' })),
        ).toMatchObject({
            addedLabels: { app: 'web', env: 'prod' },
            route: { path: [1, 0] },
        });
    });

    it('leaves a rule alone when its labels conflict or no route has its team', () => {
        expect(
            findTeamLabelFix(
                POLICY,
                rule('Other channel', {
                    team: 'engineering',
                    channel: '#other',
                }),
            ),
        ).toBeUndefined();
        expect(
            findTeamLabelFix(POLICY, rule('Support', { team: 'Support' })),
        ).toBeUndefined();
        expect(findTeamLabelFix(POLICY, rule('None', {}))).toBeUndefined();
    });

    it('adds a continue team route per decided team and leaves the input alone', () => {
        const before = JSON.stringify(POLICY);
        const { fixed, routes } = addTeamRoutes(
            POLICY,
            [{ team: 'Support', contactPoint: 'slack-platform' }],
            0,
        );
        expect(JSON.stringify(POLICY)).toBe(before);
        expect(fixed.routes![0]).toEqual({
            matchers: [eq('team', 'Support')],
            contactPoint: 'slack-platform',
            continue: true,
        });
        expect(routes).toEqual([
            {
                team: 'Support',
                route: {
                    path: [0],
                    matchers: [eq('team', 'Support')],
                    contactPoint: 'slack-platform',
                },
            },
        ]);
        expect(sent(fixed, { team: 'Support' })).toEqual(['slack-platform']);
        expect(sent(fixed, { team: 'infra' })).toEqual(['pager']);
    });

    it('renders each rule with its fix', () => {
        const md = renderGrafanaRoutingFixes({
            applied: true,
            unreachableRoutes: [],
            unhandledSeverities: [],
            unreachedContactPoints: [],
            defaultOnlyRules: [
                {
                    rule: 'pg_cron',
                    labels: { team: 'engineering' },
                    fix: 'add-labels',
                    addedLabels: { channel: '#alerts' },
                    route: {
                        path: [0],
                        matchers: [
                            eq('team', 'engineering'),
                            eq('channel', '#alerts'),
                        ],
                        contactPoint: 'slack-alerts',
                    },
                },
                {
                    rule: 'Support queue',
                    labels: { team: 'Support' },
                    fix: 'needs-decision',
                    team: 'Support',
                },
                { rule: 'Unlabelled', labels: {}, fix: 'none' },
            ],
        });
        expect(md).toMatch(/## Default route only/);
        expect(md).toContain(
            '| pg_cron | `team = engineering` | add the labels `channel = #alerts`, so it reaches `team = engineering, channel = #alerts` -> slack-alerts (route root.0) |',
        );
        expect(md).toContain('proposed route `team = Support`');
        expect(md).toContain('| Unlabelled | (no labels) | none:');
    });
});
