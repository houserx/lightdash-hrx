import { SpaceMemberRole, type SpaceShare } from '@lightdash/common';
import { render } from '@testing-library/react';
import { type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import panelClasses from '../AccessPanel/AccessPanel.module.css';
import { UserAccessAuditList } from './ShareSpaceModalContent';

/**
 * The audit list is where the origin label reaches a user, so this pins the
 * wiring rather than the label: that the row is handed the share it describes,
 * and the role title that goes with the role. Both arguments to the badge are
 * strings, so swapping them typechecks -- only a rendered row catches it.
 */
const renderWithMantine = (ui: ReactElement) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    );

const share = (overrides: Partial<SpaceShare>): SpaceShare => ({
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

const rowTexts = (container: HTMLElement) =>
    [...container.querySelectorAll(`.${panelClasses.row}`)].map(
        (row) => row.textContent,
    );

describe('given everyone who can reach a space', () => {
    describe('when the access came from a grant on the resource itself', () => {
        it('then the row says so, and says what they can do', () => {
            const { container } = renderWithMantine(
                <UserAccessAuditList
                    users={[
                        share({
                            role: SpaceMemberRole.EDITOR,
                            hasDirectAccess: true,
                            inheritedFrom: 'direct_resource',
                        }),
                    ]}
                    sessionUserUuid={undefined}
                    page={1}
                    totalPages={1}
                    onPageChange={vi.fn()}
                />,
            );

            expect(rowTexts(container)).toEqual([
                'ALAda LovelaceGranted · Can edit',
            ]);
        });
    });

    describe('when the access came from somewhere up the chain', () => {
        it('then each row names its own source and role', () => {
            const { container } = renderWithMantine(
                <UserAccessAuditList
                    users={[
                        share({}),
                        share({
                            userUuid: 'user-grace',
                            firstName: 'Grace',
                            lastName: 'Hopper',
                            role: SpaceMemberRole.ADMIN,
                            inheritedFrom: 'parent_space',
                        }),
                    ]}
                    sessionUserUuid="user-grace"
                    page={1}
                    totalPages={1}
                    onPageChange={vi.fn()}
                />,
            );

            expect(rowTexts(container)).toEqual([
                'ALAda LovelaceProject · Can view',
                'GHGrace Hopper (you)Parent · Full access',
            ]);
        });
    });
});
