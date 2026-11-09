// The alerting API client (ENG-1799): one function per route of
// /api/v2/projects/{uuid}/alerting. Each takes the project first and, last,
// an optional client (the shared one by default; embedded SDK components
// pass their own from useLightdashApi()).
import {
    type AlertNotification,
    type AlertProjectHistoryEntry,
    type AlertRulePreview,
    type AlertRuleState,
    type AlertRuleSummary,
    type AlertRuleVersion,
    type AlertRuleWithInstances,
    type AlertStateHistoryEntry,
    type AlertStateInstance,
    type ApiResponse,
    type ApiSuccessEmpty,
    type ContactPoint,
    type ContactPointTestResult,
    type CreateAlertRule,
    type CreateContactPoint,
    type NotificationRouteTree,
    type SavedNotificationRouteTree,
    type UpdateAlertRule,
    type UpdateContactPoint,
} from '@lightdash/common';
import { sharedLightdashApi, type LightdashApi } from '../../api';

/** Query of GET .../rules: every filter given must match. */
export type AlertRulesQuery = {
    state?: AlertRuleState;
    /** `key=value`, matched against the rule's labels; repeat for several. */
    label?: string | string[];
    spaceUuid?: string;
};

/** Query of GET .../history, newest first. */
export type AlertHistoryQuery = {
    /** A rule uuid. */
    rule?: string;
    /** ISO 8601 time: entries at or after it. */
    since?: string;
    /** 1 to 1000; the server defaults to 100. */
    limit?: number;
};

/** Query of GET .../notifications and .../rules/{uuid}/notifications. */
export type AlertNotificationsQuery = {
    /** A rule uuid. */
    rule?: string;
    /** A Contact Point uuid. */
    contactPoint?: string;
    limit?: number;
};

type QueryValue = string | number | string[] | undefined;

const alertingPath = (projectUuid: string, path: string) =>
    `/projects/${encodeURIComponent(projectUuid)}/alerting${path}`;

/** `?a=1&b=x&b=y`, leaving out undefined values; '' when there are none. */
const queryString = (query: Record<string, QueryValue> = {}) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
        if (value === undefined) return;
        (Array.isArray(value) ? value : [value]).forEach((item) =>
            params.append(key, String(item)),
        );
    });
    const search = params.toString();
    return search ? `?${search}` : '';
};

type AlertingResults = ApiResponse['results'];

const get = <T extends AlertingResults>(
    lightdashApi: LightdashApi,
    url: string,
) =>
    lightdashApi<T>({
        version: 'v2',
        url,
        method: 'GET',
        body: undefined,
    });

const send = <T extends AlertingResults>(
    lightdashApi: LightdashApi,
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    body?: unknown,
) =>
    lightdashApi<T>({
        version: 'v2',
        url,
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

// Alert Rules

export const getAlertRules = (
    projectUuid: string,
    query: AlertRulesQuery = {},
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertRuleSummary[]>(
        lightdashApi,
        alertingPath(projectUuid, `/rules${queryString(query)}`),
    );

export const getAlertRule = (
    projectUuid: string,
    ruleUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertRuleWithInstances>(
        lightdashApi,
        alertingPath(projectUuid, `/rules/${encodeURIComponent(ruleUuid)}`),
    );

export const createAlertRule = (
    projectUuid: string,
    rule: CreateAlertRule,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<AlertRuleWithInstances>(
        lightdashApi,
        'POST',
        alertingPath(projectUuid, '/rules'),
        rule,
    );

export const updateAlertRule = (
    projectUuid: string,
    ruleUuid: string,
    update: UpdateAlertRule,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<AlertRuleWithInstances>(
        lightdashApi,
        'PATCH',
        alertingPath(projectUuid, `/rules/${encodeURIComponent(ruleUuid)}`),
        update,
    );

export const deleteAlertRule = (
    projectUuid: string,
    ruleUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    lightdashApi<ApiSuccessEmpty['results']>({
        version: 'v2',
        url: alertingPath(
            projectUuid,
            `/rules/${encodeURIComponent(ruleUuid)}`,
        ),
        method: 'DELETE',
        body: undefined,
    });

/** "Test rule": runs the (unsaved) rule's query once and saves nothing. */
export const previewAlertRule = (
    projectUuid: string,
    rule: CreateAlertRule,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<AlertRulePreview>(
        lightdashApi,
        'POST',
        alertingPath(projectUuid, '/rules/preview'),
        rule,
    );

export const getAlertRuleVersions = (
    projectUuid: string,
    ruleUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertRuleVersion[]>(
        lightdashApi,
        alertingPath(
            projectUuid,
            `/rules/${encodeURIComponent(ruleUuid)}/versions`,
        ),
    );

export const getAlertRuleHistory = (
    projectUuid: string,
    ruleUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertStateHistoryEntry[]>(
        lightdashApi,
        alertingPath(
            projectUuid,
            `/rules/${encodeURIComponent(ruleUuid)}/history`,
        ),
    );

export const getAlertRuleNotifications = (
    projectUuid: string,
    ruleUuid: string,
    query: Omit<AlertNotificationsQuery, 'rule'> = {},
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertNotification[]>(
        lightdashApi,
        alertingPath(
            projectUuid,
            `/rules/${encodeURIComponent(ruleUuid)}/notifications${queryString(query)}`,
        ),
    );

// Project-wide state, history and notifications

export const getAlertState = (
    projectUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<{ instances: AlertStateInstance[] }>(
        lightdashApi,
        alertingPath(projectUuid, '/state'),
    );

export const getAlertHistory = (
    projectUuid: string,
    query: AlertHistoryQuery = {},
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertProjectHistoryEntry[]>(
        lightdashApi,
        alertingPath(projectUuid, `/history${queryString(query)}`),
    );

export const getAlertNotifications = (
    projectUuid: string,
    query: AlertNotificationsQuery = {},
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<AlertNotification[]>(
        lightdashApi,
        alertingPath(projectUuid, `/notifications${queryString(query)}`),
    );

// Contact Points

export const getContactPoints = (
    projectUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<ContactPoint[]>(
        lightdashApi,
        alertingPath(projectUuid, '/contact-points'),
    );

export const getContactPoint = (
    projectUuid: string,
    contactPointUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<ContactPoint>(
        lightdashApi,
        alertingPath(
            projectUuid,
            `/contact-points/${encodeURIComponent(contactPointUuid)}`,
        ),
    );

export const createContactPoint = (
    projectUuid: string,
    contactPoint: CreateContactPoint,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<ContactPoint>(
        lightdashApi,
        'POST',
        alertingPath(projectUuid, '/contact-points'),
        contactPoint,
    );

export const updateContactPoint = (
    projectUuid: string,
    contactPointUuid: string,
    update: UpdateContactPoint,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<ContactPoint>(
        lightdashApi,
        'PATCH',
        alertingPath(
            projectUuid,
            `/contact-points/${encodeURIComponent(contactPointUuid)}`,
        ),
        update,
    );

export const deleteContactPoint = (
    projectUuid: string,
    contactPointUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    lightdashApi<ApiSuccessEmpty['results']>({
        version: 'v2',
        url: alertingPath(
            projectUuid,
            `/contact-points/${encodeURIComponent(contactPointUuid)}`,
        ),
        method: 'DELETE',
        body: undefined,
    });

/** "Send test notification": a synthetic TestAlert through every integration. */
export const testContactPoint = (
    projectUuid: string,
    contactPointUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<ContactPointTestResult>(
        lightdashApi,
        'POST',
        alertingPath(
            projectUuid,
            `/contact-points/${encodeURIComponent(contactPointUuid)}/test`,
        ),
    );

// Notification Routes: one tree per project, read and saved whole

/** The saved tree, or null before the first save. */
export const getNotificationRoutes = (
    projectUuid: string,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    get<SavedNotificationRouteTree | null>(
        lightdashApi,
        alertingPath(projectUuid, '/notification-routes'),
    );

export const saveNotificationRoutes = (
    projectUuid: string,
    tree: NotificationRouteTree,
    lightdashApi: LightdashApi = sharedLightdashApi,
) =>
    send<SavedNotificationRouteTree>(
        lightdashApi,
        'PUT',
        alertingPath(projectUuid, '/notification-routes'),
        tree,
    );
