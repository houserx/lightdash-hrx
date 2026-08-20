import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lightdashApi } = vi.hoisted(() => ({ lightdashApi: vi.fn() }));
vi.mock('../api', () => ({ lightdashApi }));

const toaster = vi.hoisted(() => ({
    showToastSuccess: vi.fn(),
    showToastApiError: vi.fn(),
    showToastError: vi.fn(),
}));
vi.mock('./toaster/useToaster', () => ({ default: () => toaster }));

import {
    getResourceAccessQueryKey,
    RESOURCE_ACCESS_QUERY_KEY,
    RESOURCE_GRANTS_QUERY_KEY,
    useAddResourceGroupAccessMutation,
    useAddResourceUserAccessMutation,
    useResourceAccess,
    useResourceGrants,
    useRevokeResourceGroupAccessMutation,
    useRevokeResourceUserAccessMutation,
} from './useResourceAccess';

const PROJECT_UUID = 'e2b0c1a4-0000-4000-8000-000000000001';
const DASHBOARD_UUID = 'e2b0c1a4-0000-4000-8000-000000000002';
const BASE_URL = `/projects/${PROJECT_UUID}/resource-access/Dashboard/${DASHBOARD_UUID}`;

// Built from the exported constants, so renaming a key breaks these rather
// than leaving them asserting against a stale copy of the old name
const RESOLVED_LIST_KEY = [
    RESOURCE_ACCESS_QUERY_KEY,
    PROJECT_UUID,
    'Dashboard',
    DASHBOARD_UUID,
];
const GRANT_ROWS_KEY = [
    RESOURCE_GRANTS_QUERY_KEY,
    PROJECT_UUID,
    'Dashboard',
    DASHBOARD_UUID,
];

const share = (userUuid: string) => ({
    userUuid,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `${userUuid}@example.com`,
    role: 'viewer',
    hasDirectAccess: true,
    inheritedRole: null,
    inheritedFrom: 'direct_resource',
    projectRole: null,
});

const page = (userUuids: string[]) => ({
    data: userUuids.map(share),
    pagination: {
        page: 1,
        pageSize: 25,
        totalResults: userUuids.length,
        totalPageCount: 1,
    },
});

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>
            {children}
        </QueryClientProvider>
    );
    return { wrapper, queryClient };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('given a dashboard that may have been shared directly', () => {
    describe('when the resolved access list is requested', () => {
        it('then it asks the resource access endpoint for that page', async () => {
            lightdashApi.mockResolvedValue(page(['alice']));
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useResourceAccess(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                        { page: 1, pageSize: 25 },
                    ),
                { wrapper },
            );

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledWith({
                url: `${BASE_URL}/access?page=1&pageSize=25`,
                method: 'GET',
                body: undefined,
            });
        });

        it('then a search term is passed to the server, not filtered locally', async () => {
            lightdashApi.mockResolvedValue(page([]));
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useResourceAccess(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                        { page: 1, pageSize: 25, searchQuery: 'ada' },
                    ),
                { wrapper },
            );

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledWith({
                url: `${BASE_URL}/access?page=1&pageSize=25&searchQuery=ada`,
                method: 'GET',
                body: undefined,
            });
        });

        it('then only directly granted principals are requested when asked', async () => {
            lightdashApi.mockResolvedValue(page([]));
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useResourceAccess(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                        { page: 1, pageSize: 25, directOnly: true },
                    ),
                { wrapper },
            );

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledWith({
                url: `${BASE_URL}/access?page=1&pageSize=25&directOnly=true`,
                method: 'GET',
                body: undefined,
            });
        });
    });

    describe('when the resource is not yet known', () => {
        it('then nothing is requested', async () => {
            const { wrapper } = createWrapper();

            renderHook(
                () =>
                    useResourceAccess(undefined, 'Dashboard', undefined, {
                        page: 1,
                        pageSize: 25,
                    }),
                { wrapper },
            );

            await waitFor(() => expect(lightdashApi).not.toHaveBeenCalled());
        });
    });

    describe('when the reader moves to the next page', () => {
        it('then the current page stays on screen while the next one loads', async () => {
            const firstPage = page(['alice']);
            const secondPage = page(['bob']);
            lightdashApi.mockResolvedValueOnce(firstPage);
            const { wrapper } = createWrapper();

            const { result, rerender } = renderHook(
                ({ pageNumber }: { pageNumber: number }) =>
                    useResourceAccess(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                        { page: pageNumber, pageSize: 1 },
                    ),
                { wrapper, initialProps: { pageNumber: 1 } },
            );

            await waitFor(() => expect(result.current.data).toEqual(firstPage));

            let releaseSecondPage: (value: unknown) => void = () => {};
            lightdashApi.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseSecondPage = resolve;
                    }),
            );
            rerender({ pageNumber: 2 });

            await waitFor(() => expect(result.current.isFetching).toBe(true));
            // The regression this guards: reaching for react-query v5's
            // placeholderData in a v4 codebase, which blanks the list on paging
            expect(result.current.data).toEqual(firstPage);
            expect(result.current.isPreviousData).toBe(true);

            releaseSecondPage(secondPage);
            await waitFor(() =>
                expect(result.current.data).toEqual(secondPage),
            );
        });
    });

    describe('when the persisted grant rows are requested', () => {
        it('then both the user and group grants come back', async () => {
            const grants = {
                // Alice holds both actions -- the shape the revoke-all path
                // exists for, and what item I derives its `actions` array from
                users: [
                    { userUuid: 'alice', action: 'view' },
                    { userUuid: 'alice', action: 'manage' },
                ],
                groups: [{ groupUuid: 'analysts', action: 'manage' }],
            };
            lightdashApi.mockResolvedValue(grants);
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useResourceGrants(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledWith({
                url: BASE_URL,
                method: 'GET',
                body: undefined,
            });
            expect(result.current.data).toEqual(grants);
        });
    });
});

describe('given someone with permission to share a dashboard', () => {
    describe('when they grant a user view access', () => {
        it('then the grant is posted and both access views are refreshed', async () => {
            lightdashApi.mockResolvedValue(undefined);
            const { wrapper, queryClient } = createWrapper();
            const invalidateQueries = vi.spyOn(
                queryClient,
                'invalidateQueries',
            );

            const { result } = renderHook(
                () =>
                    useAddResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({ userUuid: 'alice', action: 'view' });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledWith({
                url: `${BASE_URL}/user`,
                method: 'POST',
                body: JSON.stringify({ userUuid: 'alice', action: 'view' }),
            });
            expect(invalidateQueries.mock.calls.map(([key]) => key)).toEqual([
                RESOLVED_LIST_KEY,
                GRANT_ROWS_KEY,
            ]);
        });

        it('then a failure is surfaced rather than silently swallowed', async () => {
            lightdashApi.mockRejectedValue({
                error: { message: 'nope', name: 'ForbiddenError' },
            });
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useAddResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({ userUuid: 'alice', action: 'view' });

            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(toaster.showToastApiError).toHaveBeenCalled();
            expect(toaster.showToastSuccess).not.toHaveBeenCalled();
        });
    });

    describe('when they grant a group manage access', () => {
        it('then the grant is posted to the group endpoint', async () => {
            lightdashApi.mockResolvedValue(undefined);
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useAddResourceGroupAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({ groupUuid: 'analysts', action: 'manage' });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledWith({
                url: `${BASE_URL}/group`,
                method: 'POST',
                body: JSON.stringify({
                    groupUuid: 'analysts',
                    action: 'manage',
                }),
            });
        });
    });
});

describe('given a principal whose grant is being taken away', () => {
    describe('when they hold a single action', () => {
        it('then that one grant is deleted', async () => {
            lightdashApi.mockResolvedValue(null);
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useRevokeResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({ userUuid: 'alice', actions: ['view'] });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).toHaveBeenCalledTimes(1);
            expect(lightdashApi).toHaveBeenCalledWith({
                url: `${BASE_URL}/user/alice/view`,
                method: 'DELETE',
                body: undefined,
            });
        });
    });

    /**
     * The trap this pins: grants are keyed on action, so `view` and `manage` coexist
     * on one resource. Revoking only the most permissive one demotes the principal to
     * viewer instead of removing them -- and the list still shows them, which reads
     * as the revoke having failed.
     */
    describe('when they hold both view and manage', () => {
        it('then every action is deleted, not just the most permissive one', async () => {
            lightdashApi.mockResolvedValue(null);
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useRevokeResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({
                userUuid: 'alice',
                actions: ['view', 'manage'],
            });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(
                lightdashApi.mock.calls.map(([request]) => request.url),
            ).toEqual([
                `${BASE_URL}/user/alice/view`,
                `${BASE_URL}/user/alice/manage`,
            ]);
        });
    });

    /**
     * Sequencing bounds the damage but does not prevent it: two grants with one
     * deleted is still half revoked. If invalidation only ran on full success, the
     * list would keep showing the principal at their old role while the server had
     * already dropped one of their grants -- an error toast over a list that looks
     * untouched.
     */
    describe('when an earlier delete succeeds and a later one fails', () => {
        it('then the cache is still refreshed, because part of the revoke landed', async () => {
            lightdashApi.mockResolvedValueOnce(null).mockRejectedValueOnce({
                error: { message: 'nope', name: 'ForbiddenError' },
            });
            const { wrapper, queryClient } = createWrapper();
            const invalidateQueries = vi.spyOn(
                queryClient,
                'invalidateQueries',
            );

            const { result } = renderHook(
                () =>
                    useRevokeResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({
                userUuid: 'alice',
                actions: ['view', 'manage'],
            });

            await waitFor(() => expect(result.current.isError).toBe(true));
            await waitFor(() =>
                expect(
                    invalidateQueries.mock.calls.map(([key]) => key),
                ).toEqual([RESOLVED_LIST_KEY, GRANT_ROWS_KEY]),
            );
        });
    });

    describe('when they hold no grant at all', () => {
        it('then nothing is sent to the server', async () => {
            const { wrapper } = createWrapper();

            const { result } = renderHook(
                () =>
                    useRevokeResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({ userUuid: 'alice', actions: [] });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(lightdashApi).not.toHaveBeenCalled();
        });
    });

    describe('when the principal is a group', () => {
        it('then every action is deleted from the group endpoint', async () => {
            lightdashApi.mockResolvedValue(null);
            const { wrapper, queryClient } = createWrapper();
            const invalidateQueries = vi.spyOn(
                queryClient,
                'invalidateQueries',
            );

            const { result } = renderHook(
                () =>
                    useRevokeResourceGroupAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({
                groupUuid: 'analysts',
                actions: ['manage', 'view'],
            });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(
                lightdashApi.mock.calls.map(([request]) => request.url),
            ).toEqual([
                `${BASE_URL}/group/analysts/manage`,
                `${BASE_URL}/group/analysts/view`,
            ]);
            expect(invalidateQueries.mock.calls.map(([key]) => key)).toEqual([
                RESOLVED_LIST_KEY,
                GRANT_ROWS_KEY,
            ]);
        });
    });
});

describe('given several pages of the access list are cached', () => {
    describe('when a grant changes', () => {
        it('then the invalidation reaches every cached page', async () => {
            lightdashApi.mockResolvedValue(undefined);
            const { wrapper, queryClient } = createWrapper();

            // Keyed through the real builder, so a reordered key fails here
            // rather than passing against a hand-written copy of its shape
            queryClient.setQueryData(
                getResourceAccessQueryKey(
                    PROJECT_UUID,
                    'Dashboard',
                    DASHBOARD_UUID,
                    {
                        page: 1,
                        pageSize: 25,
                    },
                ),
                page(['alice']),
            );
            queryClient.setQueryData(
                getResourceAccessQueryKey(
                    PROJECT_UUID,
                    'Dashboard',
                    DASHBOARD_UUID,
                    {
                        page: 2,
                        pageSize: 25,
                    },
                ),
                page(['bob']),
            );

            const { result } = renderHook(
                () =>
                    useAddResourceUserAccessMutation(
                        PROJECT_UUID,
                        'Dashboard',
                        DASHBOARD_UUID,
                    ),
                { wrapper },
            );
            result.current.mutate({ userUuid: 'carol', action: 'view' });

            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            const stale = queryClient
                .getQueryCache()
                .findAll({ queryKey: RESOLVED_LIST_KEY })
                .filter((query) => query.state.isInvalidated);
            expect(stale).toHaveLength(2);
        });
    });
});
