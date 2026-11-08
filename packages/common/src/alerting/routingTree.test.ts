import { describe, expect, it } from 'vitest';
import type { AlertLabelMatcher } from './routingMatchers';
import { routeAlert, type NotificationRoute } from './routingTree';

const eq = (label: string, value: string): AlertLabelMatcher => ({
    label,
    operator: '=',
    value,
});

const contactPoints = (
    tree: NotificationRoute,
    labels: Record<string, string>,
) => routeAlert(tree, labels).map((route) => route.contactPoint);

describe('routeAlert', () => {
    it('returns the root with Grafana default timers when nothing matches', () => {
        expect(routeAlert({ contactPoint: 'ops' }, { team: 'x' })).toEqual([
            {
                id: 'root',
                path: [],
                contactPoint: 'ops',
                groupBy: [],
                groupWait: '30s',
                groupInterval: '5m',
                repeatInterval: '4h',
            },
        ]);
    });

    it('ignores matchers on the root', () => {
        const tree: NotificationRoute = {
            contactPoint: 'ops',
            matchers: [eq('team', 'never')],
        };
        expect(contactPoints(tree, {})).toEqual(['ops']);
    });

    it('uses the deepest match and inherits unset settings down the tree', () => {
        const tree: NotificationRoute = {
            contactPoint: 'ops',
            groupBy: ['alertname'],
            repeatInterval: '1h',
            routes: [
                {
                    matchers: [eq('team', 'db')],
                    groupWait: '10s',
                    routes: [
                        {
                            matchers: [eq('severity', 'critical')],
                            contactPoint: 'pager',
                            groupBy: ['...'],
                        },
                    ],
                },
            ],
        };
        expect(routeAlert(tree, { team: 'db', severity: 'critical' })).toEqual([
            {
                id: 'root.0.0',
                path: [0, 0],
                contactPoint: 'pager',
                groupBy: ['...'],
                groupWait: '10s',
                groupInterval: '5m',
                repeatInterval: '1h',
            },
        ]);
        expect(routeAlert(tree, { team: 'db' })).toMatchObject([
            { id: 'root.0', contactPoint: 'ops', groupBy: ['alertname'] },
        ]);
    });

    it('stops at the first matching sibling unless continue is set', () => {
        const tree: NotificationRoute = {
            contactPoint: 'ops',
            routes: [
                { matchers: [eq('a', '1')], contactPoint: 'first' },
                { matchers: [eq('a', '1')], contactPoint: 'second' },
            ],
        };
        expect(contactPoints(tree, { a: '1' })).toEqual(['first']);
        tree.routes![0].continue = true;
        expect(contactPoints(tree, { a: '1' })).toEqual(['first', 'second']);
    });

    it('applies continue inside nested routes and keeps tree order', () => {
        const tree: NotificationRoute = {
            contactPoint: 'ops',
            routes: [
                {
                    matchers: [eq('team', 'web')],
                    contactPoint: 'web',
                    continue: true,
                    routes: [
                        {
                            matchers: [],
                            contactPoint: 'web-a',
                            continue: true,
                        },
                        { matchers: [], contactPoint: 'web-b' },
                        { matchers: [], contactPoint: 'web-c' },
                    ],
                },
                { matchers: [], contactPoint: 'catch-all' },
            ],
        };
        expect(contactPoints(tree, { team: 'web' })).toEqual([
            'web-a',
            'web-b',
            'catch-all',
        ]);
    });

    it('uses a route id when one is given', () => {
        const tree: NotificationRoute = {
            contactPoint: 'ops',
            routes: [{ id: 'infra', matchers: [eq('team', 'infra')] }],
        };
        expect(routeAlert(tree, { team: 'infra' })[0].id).toBe('infra');
    });

    it('leaves the contact point undefined when no route names one', () => {
        expect(routeAlert({}, {})[0].contactPoint).toBeUndefined();
    });

    it('does not share groupBy arrays with the tree', () => {
        const tree: NotificationRoute = { contactPoint: 'ops', groupBy: ['x'] };
        routeAlert(tree, {})[0].groupBy.push('y');
        expect(tree.groupBy).toEqual(['x']);
    });
});
