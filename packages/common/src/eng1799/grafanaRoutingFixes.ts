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
 */
import type { AlertRuleAsCode } from '../alerting/asCode';
import {
    matchAlertLabelMatchers,
    type AlertLabelMatcher,
    type AlertLabels,
} from '../alerting/routingMatchers';
import type { NotificationRoute } from '../alerting/routingTree';

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
};

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
    return `${lines.join('\n')}\n`;
};
