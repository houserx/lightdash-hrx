/**
 * ENG-1799 importers: routing defects in an imported Grafana notification policy, and their fixes.
 *
 * ADR 0003: known routing bugs are fixed during migration rather than reproduced, and the Shadow
 * Run compares against the written list of differences (ROUTING-FIXES.md). Every check is driven by
 * the imported rules' labels, so a fix only touches routing for alerts those rules raise.
 *
 * Unreachable routes: an alert stops at the first matching sibling route without `continue`, so a
 * later sibling that also matches the rule's labels is never reached for it, either because an
 * earlier, broader matcher catches it first (matcher order) or because an earlier route on another
 * label lacks `continue`. The fix sets `continue: true` on the earlier route: alerts keep every
 * contact point they reach today and also reach the shadowed route.
 *
 * Unhandled severities: a severity label value rules carry that no route matches on severity. When
 * the routing decisions name a contact point for the value, the fix adds a severity route for it
 * (continue: true, so the alerts still follow the rest of the tree); otherwise the value needs a
 * decision.
 *
 * Unreached contact points: an imported contact point that no route in the tree (the root's
 * default included) names, so no alert reaches it. The fix adds a notify=<contact point slug> route
 * for it (continue: true), so a rule can opt in with that label and keep the rest of its routing.
 *
 * Default route only: a rule whose alerts match no route, so they reach only the root's default
 * contact point. When the rule's team label matches a route's `team = <team>` matcher but the rule
 * lacks that route's other equality matchers, the fix adds those labels to the rule. When no route
 * matches on its team, a team the routing decisions name gets a team route (continue: true);
 * otherwise the team needs a decision. A rule with no team label stays on the default route.
 */
import type { AlertRuleAsCode } from '../alerting/asCode';
import {
    matchAlertLabelMatchers,
    type AlertLabelMatcher,
    type AlertLabels,
} from '../alerting/routingMatchers';
import { routeAlert, type NotificationRoute } from '../alerting/routingTree';

/** A route as ROUTING-FIXES.md names it. */
export type RoutingFixRoute = {
    /** Child indexes from the root ([0, 1] is the second child of the first policy). */
    path: number[];
    matchers: AlertLabelMatcher[];
    /** The route's own contact point slug, if it sets one. */
    contactPoint?: string;
};

/** A route some rules match but never reach, because an earlier sibling stops routing first. */
export type UnreachableRoute = {
    route: RoutingFixRoute;
    /** The earlier sibling without continue that catches the rules' alerts first. */
    shadowedBy: RoutingFixRoute;
    /** matcher-order: the earlier route matches on one of the same labels; else missing-continue. */
    cause: 'matcher-order' | 'missing-continue';
    /** Names of the affected rules, in import order. */
    rules: string[];
};

/** A severity label value rules carry but no route matches on severity. */
export type UnhandledSeverity = {
    value: string;
    /** Names of the rules with this severity, in import order. */
    rules: string[];
    /** The contact point slug the routing decisions assign; undefined when none does. */
    contactPoint?: string;
    /** The severity route the fix adds, when decided. */
    route?: RoutingFixRoute;
};

/** `--routing-decisions`: contact point (slug or name) per severity value and per team. */
export type GrafanaRoutingDecisions = {
    severities?: Record<string, string>;
    teams?: Record<string, string>;
};

export type GrafanaRoutingFixes = {
    /** false with --no-routing-fixes: defects are listed but the tree is as Grafana has it. */
    applied: boolean;
    unreachableRoutes: UnreachableRoute[];
    unhandledSeverities: UnhandledSeverity[];
    unreachedContactPoints: UnreachedContactPoint[];
    defaultOnlyRules: DefaultOnlyRule[];
};

/** A contact point no route names, so no alert reaches it. */
export type UnreachedContactPoint = {
    /** The contact point's slug. */
    contactPoint: string;
    /** The notify=<slug> route the fix adds. */
    route: RoutingFixRoute;
};

export const TEAM_LABEL = 'team';

/** A rule whose alerts reach only the default (root) route, and the fix for it. */
export type DefaultOnlyRule = {
    /** The rule's name. */
    rule: string;
    /** The rule's labels as imported, before any fix. */
    labels: AlertLabels;
} & (
    | {
          /** The fix adds these labels so the rule reaches `route`. */
          fix: 'add-labels';
          addedLabels: Record<string, string>;
          route: RoutingFixRoute;
      }
    | {
          /** The routing decisions name a contact point for the team: the fix adds `route`. */
          fix: 'team-route';
          team: string;
          route: RoutingFixRoute;
      }
    | {
          /** No route matches the team and no decision names one: `team = <team>` is proposed. */
          fix: 'needs-decision';
          team: string;
      }
    | {
          /** No team label to infer a route from: the rule stays on the default route. */
          fix: 'none';
      }
);

const describeRoute = (
    route: NotificationRoute,
    path: number[],
): RoutingFixRoute => ({
    path,
    matchers: route.matchers ?? [],
    ...(route.contactPoint !== undefined
        ? { contactPoint: route.contactPoint }
        : {}),
});

const pathKey = (path: readonly number[]) => path.join('.');

const routeAt = (
    tree: NotificationRoute,
    path: readonly number[],
): NotificationRoute =>
    path.reduce<NotificationRoute>(
        (route, index) => (route.routes ?? [])[index],
        tree,
    );

/** Whether an earlier route's matchers decide on a label the later route matches on. */
const sharesLabel = (earlier: NotificationRoute, later: NotificationRoute) =>
    (earlier.matchers ?? []).some((m) =>
        (later.matchers ?? []).some((n) => n.label === m.label),
    );

type Shadowing = { shadower: number[]; shadowed: number[]; rule: string };

/**
 * Every (earlier route, shadowed route, rule) in the tree as it is: for each route a rule reaches,
 * the first matching child without continue shadows the later matching children.
 */
const findShadowing = (
    tree: NotificationRoute,
    rules: { name: string; labels: AlertLabels }[],
): Shadowing[] => {
    const found: Shadowing[] = [];
    const visit = (
        route: NotificationRoute,
        path: number[],
        rule: { name: string; labels: AlertLabels },
    ) => {
        const children = route.routes ?? [];
        let stopper: number | undefined;
        children.forEach((child, index) => {
            if (!matchAlertLabelMatchers(rule.labels, child.matchers ?? []))
                return;
            const childPath = [...path, index];
            if (stopper !== undefined) {
                found.push({
                    shadower: [...path, stopper],
                    shadowed: childPath,
                    rule: rule.name,
                });
                return;
            }
            visit(child, childPath, rule);
            if (!child.continue) stopper = index;
        });
    };
    rules.forEach((rule) => visit(tree, [], rule));
    return found;
};

/**
 * Finds the unreachable routes for these rules and the tree with the fix: continue set on each
 * route that shadows one, until none is left (a fix can expose a route shadowed by a later sibling
 * in turn). `tree` itself is not changed.
 */
export const fixUnreachableRoutes = <T extends NotificationRoute>(
    tree: T,
    rules: Pick<AlertRuleAsCode, 'name' | 'labels'>[],
): { fixed: T; unreachableRoutes: UnreachableRoute[] } => {
    const ruleLabels = rules.map((rule) => ({
        name: rule.name,
        labels: rule.labels ?? {},
    }));
    const fixed = JSON.parse(JSON.stringify(tree)) as T;
    const byRoute = new Map<string, UnreachableRoute>();
    for (;;) {
        const shadowing = findShadowing(fixed, ruleLabels);
        if (shadowing.length === 0) break;
        shadowing.forEach(({ shadower, shadowed, rule }) => {
            const key = pathKey(shadowed);
            let entry = byRoute.get(key);
            if (entry === undefined) {
                const earlier = routeAt(fixed, shadower);
                const later = routeAt(fixed, shadowed);
                entry = {
                    route: describeRoute(later, shadowed),
                    shadowedBy: describeRoute(earlier, shadower),
                    cause: sharesLabel(earlier, later)
                        ? 'matcher-order'
                        : 'missing-continue',
                    rules: [],
                };
                byRoute.set(key, entry);
            }
            if (!entry.rules.includes(rule)) entry.rules.push(rule);
        });
        shadowing.forEach(({ shadower }) => {
            routeAt(fixed, shadower).continue = true;
        });
    }
    return { fixed, unreachableRoutes: [...byRoute.values()] };
};

export const SEVERITY_LABEL = 'severity';

/** Whether any route below the root matches on severity and accepts this value. */
const severityHandled = (route: NotificationRoute, value: string): boolean =>
    (route.routes ?? []).some((child) => {
        const severityMatchers = (child.matchers ?? []).filter(
            (m) => m.label === SEVERITY_LABEL,
        );
        return (
            (severityMatchers.length > 0 &&
                matchAlertLabelMatchers(
                    { [SEVERITY_LABEL]: value },
                    severityMatchers,
                )) ||
            severityHandled(child, value)
        );
    });

/**
 * The severity values these rules carry that no route in the tree matches on severity, in the
 * order the rules first carry them, with the rules that carry each.
 */
export const findUnhandledSeverities = (
    tree: NotificationRoute,
    rules: Pick<AlertRuleAsCode, 'name' | 'labels'>[],
): { value: string; rules: string[] }[] => {
    const byValue = new Map<string, string[]>();
    rules.forEach((rule) => {
        const value = rule.labels?.[SEVERITY_LABEL];
        if (value === undefined || value === '') return;
        if (!byValue.has(value)) {
            if (severityHandled(tree, value)) return;
            byValue.set(value, []);
        }
        const names = byValue.get(value);
        if (names !== undefined && !names.includes(rule.name))
            names.push(rule.name);
    });
    return [...byValue.entries()].map(([value, names]) => ({
        value,
        rules: names,
    }));
};

/**
 * The fix for unhandled severities: a severity route (continue: true) for each decided value,
 * inserted in order at `insertAt` among the root's routes. Undecided values are returned as they
 * are. `tree` itself is not changed.
 */
export const addSeverityRoutes = <T extends NotificationRoute>(
    tree: T,
    unhandled: { value: string; rules: string[]; contactPoint?: string }[],
    insertAt: number,
): { fixed: T; unhandledSeverities: UnhandledSeverity[] } => {
    const fixed = JSON.parse(JSON.stringify(tree)) as T;
    const added: NotificationRoute[] = [];
    const unhandledSeverities = unhandled.map((u): UnhandledSeverity => {
        if (u.contactPoint === undefined) {
            return { value: u.value, rules: u.rules };
        }
        const route: NotificationRoute = {
            matchers: [
                { label: SEVERITY_LABEL, operator: '=', value: u.value },
            ],
            contactPoint: u.contactPoint,
            continue: true,
        };
        const path = [insertAt + added.length];
        added.push(route);
        return { ...u, route: describeRoute(route, path) };
    });
    if (added.length > 0) {
        const routes = fixed.routes ?? [];
        fixed.routes = [
            ...routes.slice(0, insertAt),
            ...added,
            ...routes.slice(insertAt),
        ];
    }
    return { fixed, unhandledSeverities };
};

/** The contact point slugs some route in the tree names, the root included. */
const namedContactPoints = (
    route: NotificationRoute,
    into = new Set<string>(),
): Set<string> => {
    if (route.contactPoint !== undefined) into.add(route.contactPoint);
    (route.routes ?? []).forEach((child) => namedContactPoints(child, into));
    return into;
};

/** The contact point slugs, in the given order, that no route in the tree names. */
export const findUnreachedContactPoints = (
    tree: NotificationRoute,
    contactPoints: readonly string[],
): string[] => {
    const named = namedContactPoints(tree);
    return contactPoints.filter(
        (slug, index) =>
            !named.has(slug) && contactPoints.indexOf(slug) === index,
    );
};

/**
 * The fix for unreached contact points: a `<label> = <slug>` route (continue: true) for each,
 * inserted in order at `insertAt` among the root's routes. `tree` itself is not changed.
 */
export const addNotifyRoutes = <T extends NotificationRoute>(
    tree: T,
    unreached: readonly string[],
    label: string,
    insertAt: number,
): { fixed: T; unreachedContactPoints: UnreachedContactPoint[] } => {
    const fixed = JSON.parse(JSON.stringify(tree)) as T;
    const added = unreached.map(
        (slug): NotificationRoute => ({
            matchers: [{ label, operator: '=', value: slug }],
            contactPoint: slug,
            continue: true,
        }),
    );
    if (added.length > 0) {
        const routes = fixed.routes ?? [];
        fixed.routes = [
            ...routes.slice(0, insertAt),
            ...added,
            ...routes.slice(insertAt),
        ];
    }
    return {
        fixed,
        unreachedContactPoints: added.map((route, index) => ({
            contactPoint: unreached[index],
            route: describeRoute(route, [insertAt + index]),
        })),
    };
};

/** The labels routing sees for a rule's alerts: its labels plus alertname. */
const alertLabels = (rule: { name: string; labels?: AlertLabels }) => ({
    ...(rule.labels ?? {}),
    alertname: rule.name,
});

/** The rules, in the given order, whose alerts match no route and so reach only the root. */
export const findDefaultOnlyRules = <
    R extends Pick<AlertRuleAsCode, 'name' | 'labels'>,
>(
    tree: NotificationRoute,
    rules: readonly R[],
): R[] =>
    rules.filter((rule) =>
        routeAlert(tree, alertLabels(rule)).every((r) => r.path.length === 0),
    );

/**
 * The fix for a default-only rule with a team label: the first route, in tree order, with a
 * `team = <team>` matcher whose equality matchers (its ancestors' included) the rule can satisfy
 * by adding the labels it lacks, and does reach with them. Undefined when there is none.
 */
export const findTeamLabelFix = (
    tree: NotificationRoute,
    rule: Pick<AlertRuleAsCode, 'name' | 'labels'>,
):
    | { addedLabels: Record<string, string>; route: RoutingFixRoute }
    | undefined => {
    const labels = rule.labels ?? {};
    const team = labels[TEAM_LABEL];
    if (team === undefined || team === '') return undefined;
    const visit = (
        route: NotificationRoute,
        path: number[],
        inherited: AlertLabelMatcher[],
    ):
        | { addedLabels: Record<string, string>; route: RoutingFixRoute }
        | undefined => {
        const children = route.routes ?? [];
        for (let index = 0; index < children.length; index += 1) {
            const child = children[index];
            const childPath = [...path, index];
            const matchers = [...inherited, ...(child.matchers ?? [])];
            const namesTeam = (child.matchers ?? []).some(
                (m) =>
                    m.label === TEAM_LABEL &&
                    m.operator === '=' &&
                    m.value === team,
            );
            if (namesTeam) {
                const addedLabels: Record<string, string> = {};
                const consistent = matchers
                    .filter((m) => m.operator === '=')
                    .every((m) => {
                        const current = labels[m.label] ?? addedLabels[m.label];
                        if (current === undefined) {
                            addedLabels[m.label] = m.value;
                            return true;
                        }
                        return current === m.value;
                    });
                const reaches =
                    consistent &&
                    Object.keys(addedLabels).length > 0 &&
                    routeAlert(
                        tree,
                        alertLabels({
                            name: rule.name,
                            labels: { ...labels, ...addedLabels },
                        }),
                    ).some((r) =>
                        childPath.every((step, i) => r.path[i] === step),
                    );
                if (reaches) {
                    return {
                        addedLabels,
                        route: describeRoute(child, childPath),
                    };
                }
            }
            const deeper = visit(child, childPath, matchers);
            if (deeper !== undefined) return deeper;
        }
        return undefined;
    };
    return visit(tree, [], []);
};

/**
 * The fix for teams no route matches: a `team = <team>` route (continue: true) to each decided
 * contact point, inserted in order at `insertAt` among the root's routes. `tree` itself is not
 * changed.
 */
export const addTeamRoutes = <T extends NotificationRoute>(
    tree: T,
    teams: readonly { team: string; contactPoint: string }[],
    insertAt: number,
): { fixed: T; routes: { team: string; route: RoutingFixRoute }[] } => {
    const fixed = JSON.parse(JSON.stringify(tree)) as T;
    const added = teams.map(
        (t): NotificationRoute => ({
            matchers: [{ label: TEAM_LABEL, operator: '=', value: t.team }],
            contactPoint: t.contactPoint,
            continue: true,
        }),
    );
    if (added.length > 0) {
        const routes = fixed.routes ?? [];
        fixed.routes = [
            ...routes.slice(0, insertAt),
            ...added,
            ...routes.slice(insertAt),
        ];
    }
    return {
        fixed,
        routes: added.map((route, index) => ({
            team: teams[index].team,
            route: describeRoute(route, [insertAt + index]),
        })),
    };
};

const formatLabels = (labels: AlertLabels) =>
    Object.keys(labels).length === 0
        ? '(no labels)'
        : `\`${Object.entries(labels)
              .map(([label, value]) => `${label} = ${value}`)
              .join(', ')}\``;

export const formatRouteMatchers = (matchers: readonly AlertLabelMatcher[]) =>
    matchers.length === 0
        ? '(every alert)'
        : matchers.map((m) => `${m.label} ${m.operator} ${m.value}`).join(', ');

const formatRoute = (route: RoutingFixRoute) =>
    `\`${formatRouteMatchers(route.matchers)}\`${
        route.contactPoint !== undefined ? ` -> ${route.contactPoint}` : ''
    } (route ${['root', ...route.path].join('.')})`;

const cell = (text: string) =>
    text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** ROUTING-FIXES.md: every routing defect the import found and the fix for it. */
export const renderGrafanaRoutingFixes = (
    fixes: GrafanaRoutingFixes,
): string => {
    const lines = [
        '# Routing fixes',
        '',
        'Known routing bugs are fixed during migration rather than reproduced (ADR 0003). The Shadow Run',
        'compares against this list of expected routing differences, not against exact parity.',
        '',
        fixes.applied
            ? 'The fixes below are applied in notification-routes/.'
            : 'Imported with --no-routing-fixes: notification-routes/ is as Grafana has it and the fixes below are not applied.',
        '',
        '## Unreachable routes',
        '',
    ];
    if (fixes.unreachableRoutes.length === 0) {
        lines.push('No route is unreachable for the imported rules.');
    } else {
        lines.push(
            'Each route below matches these rules, but an earlier sibling route without continue catches their alerts first, so the route is an unreachable route for them.',
            '',
            '| Route | Caught first by | Cause | Affected rules | Fix |',
            '| --- | --- | --- | --- | --- |',
        );
        fixes.unreachableRoutes.forEach((u) => {
            const cause =
                u.cause === 'matcher-order'
                    ? 'matcher order: the earlier route also matches these alerts on the same label'
                    : 'missing continue on the earlier route';
            lines.push(
                `| ${cell(formatRoute(u.route))} | ${cell(
                    formatRoute(u.shadowedBy),
                )} | ${cell(cause)} | ${cell(u.rules.join(', '))} | ${cell(
                    `continue: true on route ${['root', ...u.shadowedBy.path].join('.')}, so its alerts also reach ${formatRouteMatchers(u.route.matchers)}`,
                )} |`,
            );
        });
    }
    lines.push('', '## Unhandled severities', '');
    if (fixes.unhandledSeverities.length === 0) {
        lines.push(
            'Every severity value the imported rules carry has a route.',
        );
    } else {
        lines.push(
            'No route matches these severity values, so their alerts are routed by their other labels only. A value the routing decisions (--routing-decisions, `severities:`) assign gets a severity route with continue: true, so its alerts reach that contact point and still follow the rest of the tree; the others need a decision (routing-needs-decision warning).',
            '',
            '| Severity | Affected rules | Fix |',
            '| --- | --- | --- |',
        );
        fixes.unhandledSeverities.forEach((u) => {
            const fix =
                u.route !== undefined
                    ? `severity route ${formatRoute(u.route)}, continue: true`
                    : `needs a decision: add \`severities: {"${u.value}": <contact point>}\` to --routing-decisions`;
            lines.push(
                `| ${cell(`\`${SEVERITY_LABEL} = ${u.value}\``)} | ${cell(
                    u.rules.join(', '),
                )} | ${cell(fix)} |`,
            );
        });
    }
    lines.push('', '## Unreached contact points', '');
    if (fixes.unreachedContactPoints.length === 0) {
        lines.push('Every imported contact point is named by a route.');
    } else {
        lines.push(
            'No route names these contact points, so no alert reaches them; each is an unreached contact point. The fix adds a route on its slug with continue: true, so a rule opts in by carrying that label and keeps the rest of its routing.',
            '',
            '| Contact point | Fix |',
            '| --- | --- |',
        );
        fixes.unreachedContactPoints.forEach((u) => {
            lines.push(
                `| ${cell(`\`${u.contactPoint}\``)} | ${cell(
                    `route ${formatRoute(u.route)}, continue: true`,
                )} |`,
            );
        });
    }
    lines.push('', '## Default route only', '');
    if (fixes.defaultOnlyRules.length === 0) {
        lines.push('Every imported rule reaches a route below the default.');
    } else {
        lines.push(
            "These rules match no route, so their alerts reach the default route only (the root's contact point). When a route matches on the rule's team but needs other labels the rule lacks, the fix adds those labels. When no route matches on its team, the routing decisions (--routing-decisions, `teams:`) can add a team route with continue: true; otherwise the proposed route needs a decision (routing-needs-decision warning).",
            '',
            '| Rule | Labels | Fix |',
            '| --- | --- | --- |',
        );
        fixes.defaultOnlyRules.forEach((d) => {
            let fix: string;
            switch (d.fix) {
                case 'add-labels':
                    fix = `add the labels ${formatLabels(
                        d.addedLabels,
                    )}, so it reaches ${formatRoute(d.route)}`;
                    break;
                case 'team-route':
                    fix = `team route ${formatRoute(d.route)}, continue: true`;
                    break;
                case 'needs-decision':
                    fix = `needs a decision: proposed route \`${TEAM_LABEL} = ${d.team}\`; add \`teams: {"${d.team}": <contact point>}\` to --routing-decisions`;
                    break;
                default:
                    fix =
                        'none: no team label to infer a route from, so it stays on the default route';
            }
            lines.push(
                `| ${cell(d.rule)} | ${cell(formatLabels(d.labels))} | ${cell(
                    fix,
                )} |`,
            );
        });
    }
    return `${lines.join('\n')}\n`;
};
