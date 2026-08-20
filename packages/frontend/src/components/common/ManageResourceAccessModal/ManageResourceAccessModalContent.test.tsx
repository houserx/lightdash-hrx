import {
    SpaceMemberRole,
    type ResourceAccessList,
    type ResourceShare,
} from '@lightdash/common';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import panelClasses from '../AccessPanel/AccessPanel.module.css';
import { ManageResourceAccessModalContent } from './ManageResourceAccessModalContent';

/**
 * The presentational half of the modal, kept separate from the container so it
 * can be rendered without a QueryClient -- and, more to the point, without
 * Mantine's Modal, which portals its children into `document.body` where a
 * container-scoped query cannot reach them.
 */

type ContentProps = ComponentProps<typeof ManageResourceAccessModalContent>;

const onRevokeUser = vi.fn<ContentProps['onRevokeUser']>();
const onRevokeGroup = vi.fn<ContentProps['onRevokeGroup']>();
const onPageChange = vi.fn<ContentProps['onPageChange']>();

const renderWithMantine = (ui: ReactElement) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    );

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

const noGrants: ResourceAccessList = { users: [], groups: [] };

const renderContent = (overrides: Partial<ContentProps> = {}) =>
    renderWithMantine(
        <ManageResourceAccessModalContent
            resourceType="Dashboard"
            spaceName="Finance"
            shares={[share({})]}
            grants={noGrants}
            groupNames={{}}
            sessionUserUuid={undefined}
            page={1}
            totalPages={1}
            isRevoking={false}
            onPageChange={onPageChange}
            onRevokeUser={onRevokeUser}
            onRevokeGroup={onRevokeGroup}
            {...overrides}
        />,
    );

/** Rows are found by who they name, so people and groups read the same way. */
const rowFor = (container: HTMLElement, name: string): HTMLElement => {
    const row = [...container.querySelectorAll(`.${panelClasses.row}`)].find(
        (candidate) => candidate.textContent?.includes(name),
    );

    if (!row) throw new Error(`No access row naming "${name}"`);
    return row as HTMLElement;
};

const revokeControl = (container: HTMLElement, name: string) =>
    within(rowFor(container, name)).queryByRole('button', {
        name: 'Remove grant',
    });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('given a principal who holds a grant on this resource', () => {
    describe('when their grant is what earned them access', () => {
        it('then the row offers to remove the grant', async () => {
            const { container } = renderContent({
                shares: [
                    share({
                        hasDirectAccess: true,
                        inheritedFrom: 'direct_resource',
                    }),
                ],
                grants: {
                    users: [{ userUuid: 'user-ada', action: 'view' }],
                    groups: [],
                },
            });

            const control = revokeControl(container, 'Ada Lovelace');
            expect(control).not.toBeNull();

            await userEvent.click(control!);

            expect(onRevokeUser).toHaveBeenCalledWith({
                userUuid: 'user-ada',
                actions: ['view'],
            });
        });
    });

    describe('when they hold both actions', () => {
        it('then removing names every action, most permissive first', async () => {
            const { container } = renderContent({
                grants: {
                    users: [
                        { userUuid: 'user-ada', action: 'view' },
                        { userUuid: 'user-ada', action: 'manage' },
                    ],
                    groups: [],
                },
            });

            await userEvent.click(revokeControl(container, 'Ada Lovelace')!);

            expect(onRevokeUser).toHaveBeenCalledWith({
                userUuid: 'user-ada',
                actions: ['manage', 'view'],
            });
        });
    });

    describe('when the grant is inert because a role already gave them more', () => {
        it('then it can still be removed, and says only that', async () => {
            // Their access survives this removal, so the control cannot promise
            // to remove access -- only to remove the grant.
            const { container } = renderContent({
                shares: [
                    share({
                        role: SpaceMemberRole.ADMIN,
                        hasDirectAccess: true,
                        inheritedFrom: 'project',
                    }),
                ],
                grants: {
                    users: [{ userUuid: 'user-ada', action: 'manage' }],
                    groups: [],
                },
            });

            expect(revokeControl(container, 'Ada Lovelace')).not.toBeNull();

            await userEvent.click(revokeControl(container, 'Ada Lovelace')!);

            expect(onRevokeUser).toHaveBeenCalledWith({
                userUuid: 'user-ada',
                actions: ['manage'],
            });
        });
    });
});

describe('given a principal this surface cannot revoke for', () => {
    describe('when their access is inherited from a space or a role', () => {
        it('then the row offers no removal at all', () => {
            const { container } = renderContent({});

            expect(revokeControl(container, 'Ada Lovelace')).toBeNull();
        });
    });

    describe('when the resolver attributed their access to a grant anyway', () => {
        it('then the row still offers no removal', () => {
            // A grant made to a group is expanded per member by the resolver, so
            // the row reads "Granted" -- but the grant is recorded against the
            // group. A removal here would DELETE a row that does not exist,
            // report success, and leave their access untouched.
            const { container } = renderContent({
                shares: [
                    share({
                        hasDirectAccess: true,
                        inheritedFrom: 'direct_resource',
                    }),
                ],
                grants: {
                    users: [],
                    groups: [{ groupUuid: 'group-eng', action: 'view' }],
                },
                groupNames: { 'group-eng': 'Engineering' },
            });

            expect(rowFor(container, 'Ada Lovelace').textContent).toContain(
                'Granted',
            );
            expect(revokeControl(container, 'Ada Lovelace')).toBeNull();
        });
    });
});

describe('given a grant made to a group', () => {
    describe('when the group is listed', () => {
        it('then it can be removed, naming every action it holds', async () => {
            const { container } = renderContent({
                grants: {
                    users: [],
                    groups: [
                        { groupUuid: 'group-eng', action: 'view' },
                        { groupUuid: 'group-eng', action: 'manage' },
                    ],
                },
                groupNames: { 'group-eng': 'Engineering' },
            });

            await userEvent.click(revokeControl(container, 'Engineering')!);

            expect(onRevokeGroup).toHaveBeenCalledWith({
                groupUuid: 'group-eng',
                actions: ['manage', 'view'],
            });
            expect(onRevokeUser).not.toHaveBeenCalled();
        });
    });

    describe('when the group names have not arrived', () => {
        it('then the group is still listed and still removable', async () => {
            // The name query must never gate the list: a group whose name is
            // unknown is still access someone needs to be able to remove.
            const { container } = renderContent({
                grants: {
                    users: [],
                    groups: [{ groupUuid: 'group-eng', action: 'view' }],
                },
                groupNames: {},
            });

            await userEvent.click(revokeControl(container, 'group-eng')!);

            expect(onRevokeGroup).toHaveBeenCalledWith({
                groupUuid: 'group-eng',
                actions: ['view'],
            });
        });
    });
});

describe('given both people and groups holding grants', () => {
    describe('when the surface is read as a whole', () => {
        it('then nothing on it offers to remove access', () => {
            renderContent({
                shares: [share({})],
                grants: {
                    users: [{ userUuid: 'user-ada', action: 'view' }],
                    groups: [{ groupUuid: 'group-eng', action: 'view' }],
                },
                groupNames: { 'group-eng': 'Engineering' },
            });

            // Asserted positively over every control on the surface: removing a
            // grant is not the same as removing access, and a row cannot know
            // which it will turn out to be.
            expect(
                screen
                    .getAllByRole('button')
                    .map((button) => button.textContent),
            ).toEqual(['Remove grant', 'Remove grant']);
        });
    });

    describe('when a removal is already in flight', () => {
        it('then no further removal can be started', () => {
            const { container } = renderContent({
                grants: {
                    users: [{ userUuid: 'user-ada', action: 'view' }],
                    groups: [{ groupUuid: 'group-eng', action: 'view' }],
                },
                groupNames: { 'group-eng': 'Engineering' },
                isRevoking: true,
            });

            expect(revokeControl(container, 'Ada Lovelace')).toBeDisabled();
            expect(revokeControl(container, 'Engineering')).toBeDisabled();
        });
    });
});

describe('given a resource that inherits access from its surroundings', () => {
    describe('when the modal explains what removal can and cannot do', () => {
        it('then it names the space the resource lives in', () => {
            renderContent({ spaceName: 'Finance' });

            expect(
                screen.getByText(/Only grants made here can be removed/),
            ).toBeInTheDocument();
            expect(screen.getByText(/Finance/)).toBeInTheDocument();
        });

        it('then it still explains itself when the space is unknown', () => {
            renderContent({ spaceName: null });

            expect(
                screen.getByText(/Only grants made here can be removed/),
            ).toBeInTheDocument();
        });

        it('then it calls a chart a chart', () => {
            renderContent({ resourceType: 'SavedChart' });

            expect(screen.getByText(/this chart/)).toBeInTheDocument();
        });
    });
});

describe('given more principals than fit on one page', () => {
    describe('when the list is paged', () => {
        it('then paging is offered and reported outward', async () => {
            renderContent({ page: 1, totalPages: 3 });

            const pagingButtons = screen
                .getAllByRole('button')
                .filter((button) => button.textContent === '');

            expect(pagingButtons).toHaveLength(2);
            expect(pagingButtons[0]).toBeDisabled();

            await userEvent.click(pagingButtons[1]);

            expect(onPageChange).toHaveBeenCalledWith(2);
        });
    });
});
