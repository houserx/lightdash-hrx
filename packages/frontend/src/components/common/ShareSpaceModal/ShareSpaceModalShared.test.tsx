import {
    ProjectMemberRole,
    SpaceMemberRole,
    type LightdashUser,
    type SpaceGroup,
    type SpaceShare,
} from '@lightdash/common';
import { fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import { GroupsAccessList, UserAccessList } from './ShareSpaceModalShared';

/**
 * Characterisation tests: these describe the access lists as they behave today,
 * so the extraction of the shared row/pagination components can be shown to
 * change nothing. They pass before the extraction and must keep passing after.
 *
 * Rendered with Mantine alone rather than `renderWithProviders`, which wraps
 * every tree in the real TrackingProvider and dies on import. These lists take
 * everything they render as props, so no other provider is involved.
 */
const renderWithMantine = (ui: ReactElement) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    );

const share = (overrides: Partial<SpaceShare> = {}): SpaceShare => ({
    userUuid: 'user-ada',
    role: SpaceMemberRole.VIEWER,
    hasDirectAccess: true,
    projectRole: undefined,
    inheritedRole: undefined,
    inheritedFrom: undefined,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    isInternal: false,
    avatarUrl: null,
    avatarGradient: null,
    ...overrides,
});

const sessionUser = { userUuid: 'user-ada' } as LightdashUser;

type UserListProps = ComponentProps<typeof UserAccessList>;

const renderUserList = (props: {
    accessList: SpaceShare[];
    inheritParentPermissions?: boolean;
    sessionUser?: LightdashUser;
    disabled?: boolean;
    page?: number;
    totalPages?: number;
}) => {
    const onAccessChange = vi.fn<UserListProps['onAccessChange']>();
    const onPageChange = vi.fn<UserListProps['onPageChange']>();
    renderWithMantine(
        <UserAccessList
            inheritParentPermissions={props.inheritParentPermissions ?? false}
            accessList={props.accessList}
            sessionUser={props.sessionUser}
            onAccessChange={onAccessChange}
            disabled={props.disabled}
            page={props.page ?? 1}
            totalPages={props.totalPages ?? 1}
            onPageChange={onPageChange}
        />,
    );
    return { onAccessChange, onPageChange };
};

describe('given a list of users with access to a space', () => {
    describe('when the list is rendered', () => {
        it('then each user is named', () => {
            renderUserList({
                accessList: [
                    share(),
                    share({
                        userUuid: 'user-grace',
                        firstName: undefined,
                        lastName: undefined,
                        email: 'grace@example.com',
                    }),
                ],
            });

            expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
            // Falls back to the email when there is no name on the profile
            expect(screen.getByText('grace@example.com')).toBeInTheDocument();
        });

        it('then the signed-in user is marked as themselves', () => {
            renderUserList({ accessList: [share()], sessionUser });

            expect(screen.getByText('(you)')).toBeInTheDocument();
        });

        it('then a service account is badged as one', () => {
            renderUserList({
                accessList: [
                    share({ isInternal: true, firstName: 'CI pipeline' }),
                ],
            });

            expect(screen.getByText('Service account')).toBeInTheDocument();
            expect(screen.getByText('CI pipeline')).toBeInTheDocument();
        });
    });

    describe("when a user's access cannot be edited here", () => {
        it('then their role is shown as read-only text, not a control', () => {
            renderUserList({
                accessList: [
                    share({
                        hasDirectAccess: false,
                        role: SpaceMemberRole.EDITOR,
                    }),
                ],
            });

            expect(screen.getByText('Can edit')).toBeInTheDocument();
            expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        });

        it('then the signed-in user cannot change their own role', () => {
            renderUserList({ accessList: [share()], sessionUser });

            expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        });
    });

    describe("when a user's access can be edited here", () => {
        it('then their current role is offered as a control', () => {
            renderUserList({ accessList: [share()] });

            expect(screen.getByRole('textbox')).toHaveValue('Can view');
        });

        it('then choosing a new role reports it with the user', () => {
            const { onAccessChange } = renderUserList({
                accessList: [share()],
            });

            fireEvent.click(screen.getByRole('textbox'));
            fireEvent.click(
                screen.getByText('Manage space access and content.'),
            );

            expect(onAccessChange).toHaveBeenCalledWith(
                'admin',
                expect.objectContaining({ userUuid: 'user-ada' }),
            );
        });

        it('then removal is called resetting access when the space inherits', () => {
            renderUserList({
                accessList: [share()],
                inheritParentPermissions: true,
            });

            fireEvent.click(screen.getByRole('textbox'));

            expect(screen.getByText('Reset access')).toBeInTheDocument();
            expect(screen.queryByText('No access')).not.toBeInTheDocument();
        });

        it('then removal is called no access when the space does not inherit', () => {
            renderUserList({ accessList: [share()] });

            fireEvent.click(screen.getByRole('textbox'));

            expect(screen.getByText('No access')).toBeInTheDocument();
        });

        it('then a viewer holding a higher space role is flagged for promotion', () => {
            renderUserList({
                accessList: [
                    share({
                        projectRole: ProjectMemberRole.VIEWER,
                        role: SpaceMemberRole.EDITOR,
                    }),
                ],
            });

            expect(screen.getByRole('textbox')).toHaveAttribute(
                'aria-invalid',
                'true',
            );
        });

        it('then the control is unavailable while access is being saved', () => {
            renderUserList({ accessList: [share()], disabled: true });

            expect(screen.getByRole('textbox')).toBeDisabled();
        });
    });

    describe('when the access list spans more than one page', () => {
        it('then controls are offered to move in both directions', () => {
            const { onPageChange } = renderUserList({
                accessList: [share()],
                page: 2,
                totalPages: 3,
            });

            const [previous, next] = screen.getAllByRole('button');

            fireEvent.click(next);
            expect(onPageChange).toHaveBeenCalledWith(3);

            fireEvent.click(previous);
            expect(onPageChange).toHaveBeenCalledWith(1);
        });

        it('then paging back from the first page is refused', () => {
            const { onPageChange } = renderUserList({
                accessList: [share()],
                page: 1,
                totalPages: 2,
            });

            const [previous] = screen.getAllByRole('button');
            expect(previous).toBeDisabled();

            fireEvent.click(previous);
            expect(onPageChange).not.toHaveBeenCalled();
        });

        it('then paging forward from the last page is refused', () => {
            const { onPageChange } = renderUserList({
                accessList: [share()],
                page: 2,
                totalPages: 2,
            });

            const [, next] = screen.getAllByRole('button');
            expect(next).toBeDisabled();

            fireEvent.click(next);
            expect(onPageChange).not.toHaveBeenCalled();
        });
    });

    describe('when the access list fits on one page', () => {
        it('then no page controls are shown', () => {
            renderUserList({ accessList: [share()], totalPages: 1 });

            expect(screen.queryAllByRole('button')).toHaveLength(0);
        });
    });
});

describe('given a list of groups with access to a space', () => {
    const group = (overrides: Partial<SpaceGroup> = {}): SpaceGroup => ({
        groupUuid: 'group-analysts',
        groupName: 'Analysts',
        spaceRole: SpaceMemberRole.VIEWER,
        ...overrides,
    });

    const renderGroupList = (groupsAccess: SpaceGroup[], pageSize?: number) => {
        const onAccessChange =
            vi.fn<ComponentProps<typeof GroupsAccessList>['onAccessChange']>();
        renderWithMantine(
            <GroupsAccessList
                inheritParentPermissions={false}
                groupsAccess={groupsAccess}
                onAccessChange={onAccessChange}
                pageSize={pageSize}
            />,
        );
        return { onAccessChange };
    };

    describe('when the list is rendered', () => {
        it('then each group is named with its role', () => {
            renderGroupList([group()]);

            expect(screen.getByText('Analysts')).toBeInTheDocument();
            expect(screen.getByRole('textbox')).toHaveValue('Can view');
        });

        it('then choosing a new role reports it with the group', () => {
            const { onAccessChange } = renderGroupList([group()]);

            fireEvent.click(screen.getByRole('textbox'));
            fireEvent.click(screen.getByText('Edit space contents.'));

            expect(onAccessChange).toHaveBeenCalledWith(
                'editor',
                expect.objectContaining({ groupUuid: 'group-analysts' }),
            );
        });

        it('then removal is offered for every group', () => {
            renderGroupList([group()]);

            fireEvent.click(screen.getByRole('textbox'));

            expect(screen.getByText('Remove access')).toBeInTheDocument();
        });
    });

    describe('when there are more groups than fit on a page', () => {
        it('then only one page of groups is shown at a time', () => {
            renderGroupList(
                [
                    group(),
                    group({ groupUuid: 'group-finance', groupName: 'Finance' }),
                ],
                1,
            );

            expect(screen.getByText('Analysts')).toBeInTheDocument();
            expect(screen.queryByText('Finance')).not.toBeInTheDocument();
            expect(screen.getAllByRole('button')).toHaveLength(2);
        });

        it('then moving to the next page shows the next group', () => {
            renderGroupList(
                [
                    group(),
                    group({ groupUuid: 'group-finance', groupName: 'Finance' }),
                ],
                1,
            );

            const [, next] = screen.getAllByRole('button');
            fireEvent.click(next);

            expect(screen.getByText('Finance')).toBeInTheDocument();
            expect(screen.queryByText('Analysts')).not.toBeInTheDocument();
        });
    });
});
