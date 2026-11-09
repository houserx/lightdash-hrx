// Notification grouping (ENG-1799). Alerts are grouped per route the way
// Grafana / Alertmanager do it:
// - a route's `groupBy` names the labels that split alerts into groups;
// - '...' anywhere in `groupBy` means every label, so each distinct label
//   set is its own group;
// - an empty `groupBy` puts every alert on the route in one group;
// - a label the alert doesn't have (or has as null/'') is left out of the
//   group labels, as in Alertmanager;
// - groups never span routes: the key starts with the route id, so one
//   alert routed to two routes lands in two groups.
import { type AlertLabels } from './routingMatchers';
import { type ResolvedNotificationRoute } from './routingTree';

/** The `groupBy` entry that means "group by every label". */
export const ALERT_GROUP_BY_ALL_LABELS = '...';

type GroupingRoute = Pick<ResolvedNotificationRoute, 'id' | 'groupBy'>;

/**
 * The labels that identify an alert's group on a route, sorted by name.
 * Labels that are missing, null or empty are left out.
 */
export const alertGroupLabels = (
    route: Pick<ResolvedNotificationRoute, 'groupBy'>,
    labels: AlertLabels,
): Record<string, string> => {
    const names = route.groupBy.includes(ALERT_GROUP_BY_ALL_LABELS)
        ? Object.keys(labels)
        : route.groupBy;
    return [...new Set(names)]
        .sort()
        .reduce<Record<string, string>>((acc, name) => {
            const value = labels[name];
            if (value !== undefined && value !== null && value !== '') {
                acc[name] = value;
            }
            return acc;
        }, {});
};

/**
 * A stable key for an alert's group on a route, e.g.
 * `root.1:{alertname="Disk almost full"}`. Alerts with the same key are
 * notified together; values are JSON-escaped so keys can't collide.
 */
export const alertGroupKey = (
    route: GroupingRoute,
    labels: AlertLabels,
): string => {
    const groupLabels = Object.entries(alertGroupLabels(route, labels))
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join(',');
    return `${route.id}:{${groupLabels}}`;
};
