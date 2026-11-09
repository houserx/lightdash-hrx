// React Query hooks for the alerting pages (ENG-1799), over the API client in
// ./api. Every key starts with ['alerting', projectUuid] so a save can
// invalidate the whole project's alerting data at once.
import {
    type AlertRule,
    type AlertRuleDefinition,
    type ApiError,
} from '@lightdash/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLightdashApi } from '../../providers/LightdashApi/useLightdashApi';
import {
    getAlertRule,
    getAlertRuleHistory,
    getAlertRuleNotifications,
    getAlertRules,
    getContactPoint,
    getContactPoints,
    getNotificationRoutes,
} from './api';

const alertingKey = (projectUuid: string | undefined) => [
    'alerting',
    projectUuid,
];

export const useAlertRules = (projectUuid: string | undefined) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [...alertingKey(projectUuid), 'rules'],
        queryFn: () => getAlertRules(projectUuid!, {}, lightdashApi),
        enabled: !!projectUuid,
    });
};

export const useAlertRule = (
    projectUuid: string | undefined,
    ruleUuid: string | undefined,
) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [...alertingKey(projectUuid), 'rules', ruleUuid],
        queryFn: () => getAlertRule(projectUuid!, ruleUuid!, lightdashApi),
        enabled: !!projectUuid && !!ruleUuid,
    });
};

export const useAlertRuleHistory = (
    projectUuid: string | undefined,
    ruleUuid: string | undefined,
) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [...alertingKey(projectUuid), 'rules', ruleUuid, 'history'],
        queryFn: () =>
            getAlertRuleHistory(projectUuid!, ruleUuid!, lightdashApi),
        enabled: !!projectUuid && !!ruleUuid,
    });
};

export const useAlertRuleNotifications = (
    projectUuid: string | undefined,
    ruleUuid: string | undefined,
) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [
            ...alertingKey(projectUuid),
            'rules',
            ruleUuid,
            'notifications',
        ],
        queryFn: () =>
            getAlertRuleNotifications(
                projectUuid!,
                ruleUuid!,
                {},
                lightdashApi,
            ),
        enabled: !!projectUuid && !!ruleUuid,
    });
};

export const useContactPoints = (projectUuid: string | undefined) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [...alertingKey(projectUuid), 'contact-points'],
        queryFn: () => getContactPoints(projectUuid!, lightdashApi),
        enabled: !!projectUuid,
    });
};

export const useContactPoint = (
    projectUuid: string | undefined,
    contactPointUuid: string | undefined,
) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [
            ...alertingKey(projectUuid),
            'contact-points',
            contactPointUuid,
        ],
        queryFn: () =>
            getContactPoint(projectUuid!, contactPointUuid!, lightdashApi),
        enabled: !!projectUuid && !!contactPointUuid,
    });
};

export const useNotificationRoutes = (projectUuid: string | undefined) => {
    const lightdashApi = useLightdashApi();
    return useQuery({
        queryKey: [...alertingKey(projectUuid), 'notification-routes'],
        queryFn: () => getNotificationRoutes(projectUuid!, lightdashApi),
        enabled: !!projectUuid,
    });
};

/**
 * Wraps a save so that, once it resolves, the project's alerting queries
 * refetch. The editors await the returned promise, so a rejected save keeps
 * the editor open with the user's input.
 */
export const useAlertingMutation = <TVariables, TResult>(
    projectUuid: string | undefined,
    mutationFn: (variables: TVariables) => Promise<TResult>,
) => {
    const queryClient = useQueryClient();
    return useMutation<TResult, ApiError, TVariables>({
        mutationFn,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: alertingKey(projectUuid),
            }),
    });
};

/** The message of a rejected API call (an ApiError) or of an Error. */
export const apiErrorMessage = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    const message = (e as { error?: { message?: unknown } } | null)?.error
        ?.message;
    return typeof message === 'string' ? message : 'Unknown error';
};

/** The rule's definition alone: a valid body for preview, create and patch. */
export const toAlertRuleDefinition = (
    rule: AlertRule,
): AlertRuleDefinition => ({
    name: rule.name,
    description: rule.description,
    spaceUuid: rule.spaceUuid,
    labels: rule.labels,
    annotations: rule.annotations,
    query: rule.query,
    valueColumn: rule.valueColumn,
    reducer: rule.reducer,
    condition: rule.condition,
    for: rule.for,
    keepFiringFor: rule.keepFiringFor,
    interval: rule.interval,
    timeRange: rule.timeRange,
    noDataState: rule.noDataState,
    errorState: rule.errorState,
    paused: rule.paused,
    shadow: rule.shadow,
});
