// Notification Route API types (ENG-1799): what
// /api/v2/projects/{uuid}/alerting/notification-routes accepts and returns.
// Each project has one tree, saved and read as a whole.
import { type NotificationRoutesAsCode } from './asCode';
import { type NotificationRoute } from './routingTree';

/**
 * The tree as saved with `PUT /notification-routes`: the root (default)
 * route, which needs a contact point and has no matchers or `continue`.
 * Child routes refer to Contact Points by slug.
 */
export type NotificationRouteTree = Omit<
    NotificationRoutesAsCode,
    'version' | 'type'
>;

/**
 * `GET /notification-routes`: the tree, or null before the first save, as
 * its notification_routes as-code document (with `version` and `type`).
 */
export type SavedNotificationRouteTree = NotificationRoutesAsCode & {
    /** Uploaded as code; changed only through git. */
    managed: boolean;
};

/** Every Contact Point slug the tree names, each once, in tree order. */
export const getNotificationRouteContactPoints = (
    tree: NotificationRoute,
): string[] => {
    const slugs = new Set<string>();
    const walk = (route: NotificationRoute) => {
        if (route.contactPoint !== undefined) slugs.add(route.contactPoint);
        (route.routes ?? []).forEach(walk);
    };
    walk(tree);
    return [...slugs];
};
