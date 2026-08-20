import {
    type ApiError,
    type ApiResourceAccessListResponse,
    type ApiResourceShareListResponse,
    type ResourceAccessAction,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { lightdashApi } from '../api';
import useToaster from './toaster/useToaster';

/**
 * The data layer for sharing a single dashboard or chart, deliberately shaped
 * like `useSpaceAccess` -- a resource grant resolves into an ordinary access
 * entry, so the two surfaces answer the same question and can share a UI.
 *
 * `userUuids` is not exposed here even though the endpoint accepts it. A repeated
 * query param cannot express an empty array, but the endpoint treats "nobody" and
 * "everybody" as different questions, so a caller passing `[]` would silently ask
 * for everybody. Anything that needs it must handle that case explicitly rather
 * than inherit it.
 */

export type ResourceAccessQueryParams = {
    page?: number;
    pageSize?: number;
    searchQuery?: string;
    directOnly?: boolean;
};

/** Resolved access: everyone who can reach the resource, and where from. */
export type ResourceAccessPage = ApiResourceShareListResponse['results'];

/** The persisted grant rows alone -- which actions are held, by whom. */
export type ResourceGrants = ApiResourceAccessListResponse['results'];

export const RESOURCE_ACCESS_QUERY_KEY = 'resource_access';
export const RESOURCE_GRANTS_QUERY_KEY = 'resource_grants';

const resourceAccessUrl = (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
) => `/projects/${projectUuid}/resource-access/${resourceType}/${resourceUuid}`;

export const buildResourceAccessQueryString = (
    params: ResourceAccessQueryParams,
): string => {
    const urlParams = new URLSearchParams();
    // Compared against undefined, not truthiness: page 0 is a value, not an absence
    if (params.page !== undefined) {
        urlParams.set('page', String(params.page));
    }
    if (params.pageSize !== undefined) {
        urlParams.set('pageSize', String(params.pageSize));
    }
    if (params.searchQuery) {
        urlParams.set('searchQuery', params.searchQuery);
    }
    if (params.directOnly) {
        urlParams.set('directOnly', 'true');
    }
    return urlParams.toString();
};

/**
 * Resource identity comes before the params, so the four-element prefix matches
 * every cached page and one invalidation refreshes the whole list.
 */
export const getResourceAccessQueryKey = (
    projectUuid: string | undefined,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string | undefined,
    params: ResourceAccessQueryParams,
) => [
    RESOURCE_ACCESS_QUERY_KEY,
    projectUuid,
    resourceType,
    resourceUuid,
    params.page ?? null,
    params.pageSize ?? null,
    params.searchQuery ?? '',
    params.directOnly ?? false,
];

const getResourceAccess = async (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
    params: ResourceAccessQueryParams,
) => {
    const queryString = buildResourceAccessQueryString(params);
    return lightdashApi<ResourceAccessPage>({
        url: `${resourceAccessUrl(projectUuid, resourceType, resourceUuid)}/access${
            queryString ? `?${queryString}` : ''
        }`,
        method: 'GET',
        body: undefined,
    });
};

export const useResourceAccess = (
    projectUuid: string | undefined,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string | undefined,
    params: {
        page: number;
        pageSize: number;
        searchQuery?: string;
        directOnly?: boolean;
    },
    options?: { enabled?: boolean },
) =>
    useQuery<ResourceAccessPage, ApiError>({
        queryKey: getResourceAccessQueryKey(
            projectUuid,
            resourceType,
            resourceUuid,
            params,
        ),
        queryFn: () =>
            getResourceAccess(
                projectUuid!,
                resourceType,
                resourceUuid!,
                params,
            ),
        enabled: !!projectUuid && !!resourceUuid && (options?.enabled ?? true),
        keepPreviousData: true,
    });

export const useResourceGrants = (
    projectUuid: string | undefined,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string | undefined,
    options?: { enabled?: boolean },
) =>
    useQuery<ResourceGrants, ApiError>({
        queryKey: [
            RESOURCE_GRANTS_QUERY_KEY,
            projectUuid,
            resourceType,
            resourceUuid,
        ],
        queryFn: () =>
            lightdashApi<ResourceGrants>({
                url: resourceAccessUrl(
                    projectUuid!,
                    resourceType,
                    resourceUuid!,
                ),
                method: 'GET',
                body: undefined,
            }),
        enabled: !!projectUuid && !!resourceUuid && (options?.enabled ?? true),
    });

/**
 * Both views of the same state: the resolved people list and the grant rows that
 * back it. Only these two -- a grant changes neither the dashboard nor its space,
 * so nothing else holds stale data.
 */
const useInvalidateResourceAccess = (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
) => {
    const queryClient = useQueryClient();
    return useCallback(async () => {
        await queryClient.invalidateQueries([
            RESOURCE_ACCESS_QUERY_KEY,
            projectUuid,
            resourceType,
            resourceUuid,
        ]);
        await queryClient.invalidateQueries([
            RESOURCE_GRANTS_QUERY_KEY,
            projectUuid,
            resourceType,
            resourceUuid,
        ]);
    }, [queryClient, projectUuid, resourceType, resourceUuid]);
};

export const useAddResourceUserAccessMutation = (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
) => {
    const { showToastSuccess, showToastApiError } = useToaster();
    const invalidate = useInvalidateResourceAccess(
        projectUuid,
        resourceType,
        resourceUuid,
    );

    return useMutation<
        undefined,
        ApiError,
        { userUuid: string; action: ResourceAccessAction }
    >(
        ({ userUuid, action }) =>
            lightdashApi<undefined>({
                url: `${resourceAccessUrl(
                    projectUuid,
                    resourceType,
                    resourceUuid,
                )}/user`,
                method: 'POST',
                body: JSON.stringify({ userUuid, action }),
            }),
        {
            mutationKey: [
                'resource_share',
                projectUuid,
                resourceType,
                resourceUuid,
            ],
            onSuccess: async () => {
                await invalidate();
                showToastSuccess({ title: 'Success! Access updated.' });
            },
            onError: ({ error }) => {
                showToastApiError({
                    title: 'Failed to update access',
                    apiError: error,
                });
            },
        },
    );
};

export const useAddResourceGroupAccessMutation = (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
) => {
    const { showToastSuccess, showToastApiError } = useToaster();
    const invalidate = useInvalidateResourceAccess(
        projectUuid,
        resourceType,
        resourceUuid,
    );

    return useMutation<
        undefined,
        ApiError,
        { groupUuid: string; action: ResourceAccessAction }
    >(
        ({ groupUuid, action }) =>
            lightdashApi<undefined>({
                url: `${resourceAccessUrl(
                    projectUuid,
                    resourceType,
                    resourceUuid,
                )}/group`,
                method: 'POST',
                body: JSON.stringify({ groupUuid, action }),
            }),
        {
            mutationKey: [
                'resource_group_share',
                projectUuid,
                resourceType,
                resourceUuid,
            ],
            onSuccess: async () => {
                await invalidate();
                showToastSuccess({ title: 'Success! Group access updated.' });
            },
            onError: ({ error }) => {
                showToastApiError({
                    title: 'Failed to update group access',
                    apiError: error,
                });
            },
        },
    );
};

/**
 * Takes the set of actions held, not one action, because grants are keyed on
 * action: `view` and `manage` coexist on the same resource, and deleting only the
 * most permissive one demotes the principal to viewer instead of removing them.
 * Feed this from `useResourceGrants`, which says exactly which actions are held.
 *
 * Sequential rather than concurrent so a rejected delete stops the rest instead of
 * leaving a half-revoked principal behind.
 */
export const useRevokeResourceUserAccessMutation = (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
) => {
    const { showToastSuccess, showToastApiError } = useToaster();
    const invalidate = useInvalidateResourceAccess(
        projectUuid,
        resourceType,
        resourceUuid,
    );

    return useMutation<
        void,
        ApiError,
        { userUuid: string; actions: ResourceAccessAction[] }
    >(
        async ({ userUuid, actions }) => {
            for (const action of actions) {
                // eslint-disable-next-line no-await-in-loop
                await lightdashApi<null>({
                    url: `${resourceAccessUrl(
                        projectUuid,
                        resourceType,
                        resourceUuid,
                    )}/user/${userUuid}/${action}`,
                    method: 'DELETE',
                    body: undefined,
                });
            }
        },
        {
            mutationKey: [
                'resource_unshare',
                projectUuid,
                resourceType,
                resourceUuid,
            ],
            // On settle rather than success: a revoke that fails partway has
            // already deleted the earlier grants, so the cache is stale either way
            onSettled: invalidate,
            onSuccess: () => {
                showToastSuccess({ title: 'Success! Access updated.' });
            },
            onError: ({ error }) => {
                showToastApiError({
                    title: 'Failed to update access',
                    apiError: error,
                });
            },
        },
    );
};

export const useRevokeResourceGroupAccessMutation = (
    projectUuid: string,
    resourceType: ResourceAccessResourceType,
    resourceUuid: string,
) => {
    const { showToastSuccess, showToastApiError } = useToaster();
    const invalidate = useInvalidateResourceAccess(
        projectUuid,
        resourceType,
        resourceUuid,
    );

    return useMutation<
        void,
        ApiError,
        { groupUuid: string; actions: ResourceAccessAction[] }
    >(
        async ({ groupUuid, actions }) => {
            for (const action of actions) {
                // eslint-disable-next-line no-await-in-loop
                await lightdashApi<null>({
                    url: `${resourceAccessUrl(
                        projectUuid,
                        resourceType,
                        resourceUuid,
                    )}/group/${groupUuid}/${action}`,
                    method: 'DELETE',
                    body: undefined,
                });
            }
        },
        {
            mutationKey: [
                'resource_group_unshare',
                projectUuid,
                resourceType,
                resourceUuid,
            ],
            onSettled: invalidate,
            onSuccess: () => {
                showToastSuccess({ title: 'Success! Group access updated.' });
            },
            onError: ({ error }) => {
                showToastApiError({
                    title: 'Failed to update group access',
                    apiError: error,
                });
            },
        },
    );
};
