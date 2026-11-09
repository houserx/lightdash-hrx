// Notification Route tree (ENG-1799). Routing follows Grafana's notification
// policies (Alertmanager routes):
// - the root (default) route matches every alert, whatever its matchers;
// - child routes are tried in order; an alert goes to the deepest matching
//   route, and a matching route with no matching child is used itself;
// - after the first matching sibling, routing stops unless that route has
//   `continue` set;
// - contact point, group_by and the timers are inherited from the parent
//   when a route leaves them unset; the root falls back to Grafana's
//   defaults (group_wait 30s, group_interval 5m, repeat_interval 4h).
import {
    matchAlertLabelMatchers,
    type AlertLabelMatcher,
    type AlertLabels,
} from './routingMatchers';

export const DEFAULT_ALERT_ROUTE_GROUP_WAIT = '30s';
export const DEFAULT_ALERT_ROUTE_GROUP_INTERVAL = '5m';
export const DEFAULT_ALERT_ROUTE_REPEAT_INTERVAL = '4h';
/** Root group_by when the tree sets none: Alertmanager's single group. */
export const DEFAULT_ALERT_ROUTE_GROUP_BY: readonly string[] = [];

/** A Notification Route as saved; the root is the default route. */
export type NotificationRoute = {
    /** Optional stable id; defaults to the route's path in the tree. */
    id?: string;
    /** Ignored on the root, which matches every alert. */
    matchers?: AlertLabelMatcher[];
    contactPoint?: string;
    /** Label names; '...' means every label. */
    groupBy?: string[];
    groupWait?: string;
    groupInterval?: string;
    repeatInterval?: string;
    continue?: boolean;
    routes?: NotificationRoute[];
};

/** The route an alert was sent to, with inherited settings filled in. */
export type ResolvedNotificationRoute = {
    /** The route's own id, or its path ('root', 'root.0', 'root.0.1', ...). */
    id: string;
    /** Child indexes from the root to this route ([] is the root). */
    path: number[];
    /** Undefined only when no route up to the root names a contact point. */
    contactPoint: string | undefined;
    groupBy: string[];
    groupWait: string;
    groupInterval: string;
    repeatInterval: string;
};

type InheritedSettings = Omit<ResolvedNotificationRoute, 'id' | 'path'>;

const routePathId = (path: readonly number[]): string =>
    ['root', ...path].join('.');

const inherit = (
    route: NotificationRoute,
    parent: InheritedSettings,
): InheritedSettings => ({
    contactPoint: route.contactPoint ?? parent.contactPoint,
    groupBy: route.groupBy ? [...route.groupBy] : [...parent.groupBy],
    groupWait: route.groupWait ?? parent.groupWait,
    groupInterval: route.groupInterval ?? parent.groupInterval,
    repeatInterval: route.repeatInterval ?? parent.repeatInterval,
});

const resolve = (
    route: NotificationRoute,
    path: number[],
    settings: InheritedSettings,
): ResolvedNotificationRoute => ({
    id: route.id ?? routePathId(path),
    path,
    ...settings,
});

const matchChildren = (
    route: NotificationRoute,
    path: number[],
    settings: InheritedSettings,
    labels: AlertLabels,
): ResolvedNotificationRoute[] => {
    const matched: ResolvedNotificationRoute[] = [];
    const children = route.routes ?? [];
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (matchAlertLabelMatchers(labels, child.matchers ?? [])) {
            const childPath = [...path, index];
            const childSettings = inherit(child, settings);
            const deeper = matchChildren(
                child,
                childPath,
                childSettings,
                labels,
            );
            matched.push(
                ...(deeper.length > 0
                    ? deeper
                    : [resolve(child, childPath, childSettings)]),
            );
            if (!child.continue) break;
        }
    }
    return matched;
};

/**
 * The routes an alert with these labels is sent to, in tree order. Never
 * empty: when no child route matches, the default (root) route is returned.
 */
export const routeAlert = (
    tree: NotificationRoute,
    labels: AlertLabels,
): ResolvedNotificationRoute[] => {
    const rootSettings = inherit(tree, {
        contactPoint: undefined,
        groupBy: [...DEFAULT_ALERT_ROUTE_GROUP_BY],
        groupWait: DEFAULT_ALERT_ROUTE_GROUP_WAIT,
        groupInterval: DEFAULT_ALERT_ROUTE_GROUP_INTERVAL,
        repeatInterval: DEFAULT_ALERT_ROUTE_REPEAT_INTERVAL,
    });
    const matched = matchChildren(tree, [], rootSettings, labels);
    return matched.length > 0 ? matched : [resolve(tree, [], rootSettings)];
};
