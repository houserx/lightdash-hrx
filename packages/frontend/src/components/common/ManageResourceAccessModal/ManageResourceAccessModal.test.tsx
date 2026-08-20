import {
    SpaceMemberRole,
    type GroupWithMembers,
    type ResourceAccessList,
    type ResourceShare,
} from '@lightdash/common';
import { act, render } from '@testing-library/react';
import { type ComponentProps, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrganizationGroups } from '../../../hooks/useOrganizationGroups';
import {
    useResourceAccess,
    useResourceGrants,
    useRevokeResourceGroupAccessMutation,
    useRevokeResourceUserAccessMutation,
} from '../../../hooks/useResourceAccess';
import MantineProvider from '../../../providers/MantineProvider';
import { ManageResourceAccessModal } from './ManageResourceAccessModal';
import { type ManageResourceAccessModalContent } from './ManageResourceAccessModalContent';

/**
 * The container's whole job is wiring, and wiring mistakes typecheck: the
 * resolved page and the grant list are different shapes, but which query feeds
 * `totalPages`, which mutation a callback reaches, and whether a query runs at
 * all are all invisible to the compiler.
 *
 * So the body is replaced with a prop recorder. Asserting on rendered output
 * here would test the body again and the wiring not at all -- and the body is
 * behind Mantine's Modal portal anyway.
 */

vi.mock('../../../hooks/useResourceAccess', () => ({
    useResourceAccess: vi.fn(),
    useResourceGrants: vi.fn(),
    useRevokeResourceUserAccessMutation: vi.fn(),
    useRevokeResourceGroupAccessMutation: vi.fn(),
}));

vi.mock('../../../hooks/useOrganizationGroups', () => ({
    useOrganizationGroups: vi.fn(),
}));

vi.mock('../../../providers/App/useApp', () => ({
    default: () => ({ user: { data: { userUuid: 'user-me' } } }),
}));

type ContentProps = ComponentProps<typeof ManageResourceAccessModalContent>;

let contentProps: ContentProps | undefined;

vi.mock('./ManageResourceAccessModalContent', () => ({
    ManageResourceAccessModalContent: (props: ContentProps) => {
        contentProps = props;
        return null;
    },
}));

const revokeUser = vi.fn();
const revokeGroup = vi.fn();

const share = (overrides: Partial<ResourceShare>): ResourceShare => ({
    userUuid: 'user-ada',
    role: SpaceMemberRole.VIEWER,
    hasDirectAccess: false,
    projectRole: undefined,
    inheritedRole: undefined,
    inheritedFrom: 'project',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    isInternal: false,
    avatarUrl: null,
    avatarGradient: null,
    ...overrides,
});

/** Only the two fields the modal reads; the rest is what the API returns. */
const group = (uuid: string, name: string): GroupWithMembers => ({
    uuid,
    name,
    createdAt: new Date(0),
    createdByUserUuid: null,
    updatedAt: new Date(0),
    updatedByUserUuid: null,
    organizationUuid: 'org-1',
    memberUuids: [],
    members: [],
});

const grants: ResourceAccessList = {
    users: [{ userUuid: 'user-ada', action: 'view' }],
    groups: [{ groupUuid: 'group-eng', action: 'manage' }],
};

type AccessQuery = ReturnType<typeof useResourceAccess>;
type GrantsQuery = ReturnType<typeof useResourceGrants>;
type GroupsQuery = ReturnType<typeof useOrganizationGroups>;
type RevokeUserMutation = ReturnType<
    typeof useRevokeResourceUserAccessMutation
>;
type RevokeGroupMutation = ReturnType<
    typeof useRevokeResourceGroupAccessMutation
>;

const givenQueries = ({
    accessPage,
    grantList,
    groups,
    isRevokingUser = false,
    isRevokingGroup = false,
}: {
    accessPage: AccessQuery['data'];
    grantList: GrantsQuery['data'];
    groups: GroupsQuery['data'];
    isRevokingUser?: boolean;
    isRevokingGroup?: boolean;
}) => {
    vi.mocked(useResourceAccess).mockReturnValue({
        data: accessPage,
        isInitialLoading: false,
    } as unknown as AccessQuery);
    vi.mocked(useResourceGrants).mockReturnValue({
        data: grantList,
        isInitialLoading: false,
    } as unknown as GrantsQuery);
    vi.mocked(useOrganizationGroups).mockReturnValue({
        data: groups,
    } as unknown as GroupsQuery);
    vi.mocked(useRevokeResourceUserAccessMutation).mockReturnValue({
        mutate: revokeUser,
        isLoading: isRevokingUser,
    } as unknown as RevokeUserMutation);
    vi.mocked(useRevokeResourceGroupAccessMutation).mockReturnValue({
        mutate: revokeGroup,
        isLoading: isRevokingGroup,
    } as unknown as RevokeGroupMutation);
};

const renderModal = (opened = true): ReactElement => (
    <MantineProvider env="test" forceColorScheme="light">
        <ManageResourceAccessModal
            opened={opened}
            onClose={vi.fn()}
            projectUuid="project-1"
            resourceType="Dashboard"
            resourceUuid="dashboard-1"
            resourceName="Q3 Revenue"
            spaceName="Finance"
        />
    </MantineProvider>
);

beforeEach(() => {
    vi.clearAllMocks();
    contentProps = undefined;
    givenQueries({
        accessPage: {
            data: [share({})],
            pagination: {
                page: 1,
                pageSize: 10,
                totalPageCount: 4,
                totalResults: 37,
            },
        },
        grantList: grants,
        groups: [],
    });
});

describe('given a resource whose access is being managed', () => {
    describe('when the modal is open', () => {
        it('then the resolved page and the grants behind it both reach the body', () => {
            render(renderModal());

            expect(contentProps?.shares).toEqual([share({})]);
            expect(contentProps?.grants).toEqual(grants);
            expect(contentProps?.totalPages).toBe(4);
            expect(contentProps?.sessionUserUuid).toBe('user-me');
            expect(contentProps?.spaceName).toBe('Finance');
            expect(contentProps?.resourceType).toBe('Dashboard');
        });
    });

    describe('when the grant list has not arrived yet', () => {
        it('then nothing is offered as removable', () => {
            // Fail closed: an empty grant list means the body offers no removal.
            // Defaulting to anything else would offer a removal before knowing
            // whether there is a grant to remove.
            givenQueries({
                accessPage: { data: [share({})], pagination: undefined },
                grantList: undefined,
                groups: [],
            });

            render(renderModal());

            expect(contentProps?.grants).toEqual({ users: [], groups: [] });
        });
    });

    describe('when the resolved page reports no pagination', () => {
        it('then the list is a single page rather than none', () => {
            givenQueries({
                accessPage: { data: [share({})], pagination: undefined },
                grantList: grants,
                groups: [],
            });

            render(renderModal());

            expect(contentProps?.totalPages).toBe(1);
            expect(contentProps?.shares).toEqual([share({})]);
        });
    });

    describe('when the modal is closed', () => {
        it('then neither query runs', () => {
            render(renderModal(false));

            expect(vi.mocked(useResourceAccess).mock.calls[0]?.[4]).toEqual({
                enabled: false,
            });
            expect(vi.mocked(useResourceGrants).mock.calls[0]?.[3]).toEqual({
                enabled: false,
            });
        });
    });
});

describe('given a removal started from the body', () => {
    describe('when it is a person', () => {
        it('then the user revoke runs with every action it was handed', () => {
            render(renderModal());

            contentProps?.onRevokeUser({
                userUuid: 'user-ada',
                actions: ['manage', 'view'],
            });

            expect(revokeUser).toHaveBeenCalledWith({
                userUuid: 'user-ada',
                actions: ['manage', 'view'],
            });
            expect(revokeGroup).not.toHaveBeenCalled();
        });
    });

    describe('when it is a group', () => {
        it('then the group revoke runs, not the user one', () => {
            render(renderModal());

            contentProps?.onRevokeGroup({
                groupUuid: 'group-eng',
                actions: ['manage'],
            });

            expect(revokeGroup).toHaveBeenCalledWith({
                groupUuid: 'group-eng',
                actions: ['manage'],
            });
            expect(revokeUser).not.toHaveBeenCalled();
        });
    });

    describe.each([
        { who: 'a person', isRevokingUser: true, isRevokingGroup: false },
        { who: 'a group', isRevokingUser: false, isRevokingGroup: true },
    ])('when a removal for $who is in flight', (flags) => {
        it('then the body is told a removal is running', () => {
            givenQueries({
                accessPage: { data: [share({})], pagination: undefined },
                grantList: grants,
                groups: [],
                ...flags,
            });

            render(renderModal());

            expect(contentProps?.isRevoking).toBe(true);
        });
    });
});

describe('given groups that hold grants', () => {
    describe('when the organization groups are known', () => {
        it('then their names reach the body, keyed by uuid', () => {
            givenQueries({
                accessPage: { data: [share({})], pagination: undefined },
                grantList: grants,
                groups: [group('group-eng', 'Engineering')],
            });

            render(renderModal());

            expect(contentProps?.groupNames).toEqual({
                'group-eng': 'Engineering',
            });
        });
    });

    describe('when the group query has returned nothing', () => {
        it('then the body is handed no names rather than nothing at all', () => {
            givenQueries({
                accessPage: { data: [share({})], pagination: undefined },
                grantList: grants,
                groups: undefined,
            });

            render(renderModal());

            expect(contentProps?.groupNames).toEqual({});
        });
    });
});

describe('given a list longer than one page', () => {
    describe('when the body reports a page change', () => {
        it('then the next query asks for that page', () => {
            render(renderModal());

            expect(
                vi.mocked(useResourceAccess).mock.calls[0]?.[3],
            ).toMatchObject({ page: 1 });

            // Flushed through act: the body reports the change with a plain
            // call, not an event, so React has nothing else to batch it into.
            act(() => contentProps?.onPageChange(3));

            const lastCall = vi.mocked(useResourceAccess).mock.calls.at(-1);
            expect(lastCall?.[3]).toMatchObject({ page: 3 });
        });
    });
});
