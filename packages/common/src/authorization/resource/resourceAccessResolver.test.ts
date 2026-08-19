import { OrganizationMemberRole } from '../../types/organizationMemberProfile';
import { ProjectMemberRole } from '../../types/projectMemberRole';
import {
    DirectResourceAccessOrigin,
    type DirectResourceAccess,
} from '../../types/resourceAccess';
import { SpaceMemberRole, type SpaceAccess } from '../../types/space';
import { resolveResourceAccess } from './resourceAccessResolver';

const RESOURCE_UUID = 'dashboard-1';
const OTHER_RESOURCE_UUID = 'dashboard-2';

const spaceEntry = (overrides: Partial<SpaceAccess> = {}): SpaceAccess => ({
    userUuid: 'user-1',
    role: SpaceMemberRole.VIEWER,
    hasDirectAccess: false,
    projectRole: ProjectMemberRole.VIEWER,
    inheritedRole: OrganizationMemberRole.VIEWER,
    inheritedFrom: 'project',
    ...overrides,
});

const userGrant = (
    overrides: Partial<DirectResourceAccess> = {},
): DirectResourceAccess => ({
    userUuid: 'user-1',
    resourceUuid: RESOURCE_UUID,
    groupUuid: null,
    action: 'view',
    from: DirectResourceAccessOrigin.USER_ACCESS,
    ...overrides,
});

const groupGrant = (
    overrides: Partial<DirectResourceAccess> = {},
): DirectResourceAccess =>
    userGrant({
        groupUuid: 'group-1',
        from: DirectResourceAccessOrigin.GROUP_ACCESS,
        ...overrides,
    });

const resolve = (
    spaceAccess: SpaceAccess[],
    directResourceAccess: DirectResourceAccess[],
) =>
    resolveResourceAccess({
        resourceUuid: RESOURCE_UUID,
        spaceAccess,
        directResourceAccess,
    });

describe('resolveResourceAccess', () => {
    describe('given no grants', () => {
        it('then space access passes through unchanged', () => {
            const spaceAccess = [spaceEntry()];

            expect(resolve(spaceAccess, [])).toEqual(spaceAccess);
        });

        it('then empty space access resolves to no access', () => {
            expect(resolve([], [])).toEqual([]);
        });
    });

    describe('given a grant for a user with no space access', () => {
        it('then a view grant produces a viewer entry attributed to the resource', () => {
            const result = resolve([], [userGrant({ action: 'view' })]);

            expect(result).toEqual([
                {
                    userUuid: 'user-1',
                    role: SpaceMemberRole.VIEWER,
                    hasDirectAccess: true,
                    projectRole: undefined,
                    inheritedRole: undefined,
                    inheritedFrom: 'direct_resource',
                },
            ]);
        });

        it('then a manage grant produces an editor entry', () => {
            const result = resolve([], [userGrant({ action: 'manage' })]);

            expect(result).toHaveLength(1);
            expect(result[0].role).toBe(SpaceMemberRole.EDITOR);
            expect(result[0].inheritedFrom).toBe('direct_resource');
        });

        it('then a group grant is honoured the same as a user grant', () => {
            const result = resolve([], [groupGrant({ action: 'manage' })]);

            expect(result).toHaveLength(1);
            expect(result[0].role).toBe(SpaceMemberRole.EDITOR);
        });
    });

    describe('given a grant for a user who already has space access', () => {
        it('then a higher grant upgrades the role and re-attributes it', () => {
            const result = resolve(
                [spaceEntry({ role: SpaceMemberRole.VIEWER })],
                [userGrant({ action: 'manage' })],
            );

            expect(result).toHaveLength(1);
            expect(result[0].role).toBe(SpaceMemberRole.EDITOR);
            expect(result[0].hasDirectAccess).toBe(true);
            expect(result[0].inheritedFrom).toBe('direct_resource');
        });

        it('then a lower grant never downgrades the space role', () => {
            const result = resolve(
                [spaceEntry({ role: SpaceMemberRole.ADMIN })],
                [userGrant({ action: 'view' })],
            );

            expect(result).toHaveLength(1);
            expect(result[0].role).toBe(SpaceMemberRole.ADMIN);
        });

        it('then a losing grant leaves the original attribution intact', () => {
            const result = resolve(
                [
                    spaceEntry({
                        role: SpaceMemberRole.ADMIN,
                        inheritedFrom: 'organization',
                    }),
                ],
                [userGrant({ action: 'view' })],
            );

            expect(result[0].inheritedFrom).toBe('organization');
        });

        it('then role metadata from the space layer is preserved on upgrade', () => {
            const result = resolve(
                [
                    spaceEntry({
                        role: SpaceMemberRole.VIEWER,
                        projectRole: ProjectMemberRole.VIEWER,
                        inheritedRole: OrganizationMemberRole.VIEWER,
                    }),
                ],
                [userGrant({ action: 'manage' })],
            );

            expect(result[0].projectRole).toBe(ProjectMemberRole.VIEWER);
            expect(result[0].inheritedRole).toBe(OrganizationMemberRole.VIEWER);
        });
    });

    describe('given several grants for the same user', () => {
        it('then the most permissive grant wins', () => {
            const result = resolve(
                [],
                [
                    userGrant({ action: 'view' }),
                    groupGrant({ action: 'manage' }),
                ],
            );

            expect(result).toHaveLength(1);
            expect(result[0].role).toBe(SpaceMemberRole.EDITOR);
        });

        it('then a user-level grant does not override a higher group grant', () => {
            // Deliberate divergence from space access, where a direct user
            // entry beats a group entry regardless of height. Grants are
            // purely additive, so the most permissive source wins.
            const result = resolve(
                [],
                [
                    groupGrant({ action: 'manage' }),
                    userGrant({ action: 'view' }),
                ],
            );

            expect(result[0].role).toBe(SpaceMemberRole.EDITOR);
        });
    });

    describe('given grants for another resource', () => {
        it('then they are ignored', () => {
            const result = resolve(
                [],
                [
                    userGrant({
                        resourceUuid: OTHER_RESOURCE_UUID,
                        action: 'manage',
                    }),
                ],
            );

            expect(result).toEqual([]);
        });
    });

    describe('given grants for several users', () => {
        it('then each user resolves independently', () => {
            const result = resolve(
                [spaceEntry({ userUuid: 'user-1' })],
                [
                    userGrant({ userUuid: 'user-1', action: 'manage' }),
                    userGrant({ userUuid: 'user-2', action: 'view' }),
                ],
            );

            expect(result).toHaveLength(2);
            expect(
                result.find((entry) => entry.userUuid === 'user-1')?.role,
            ).toBe(SpaceMemberRole.EDITOR);
            expect(
                result.find((entry) => entry.userUuid === 'user-2')?.role,
            ).toBe(SpaceMemberRole.VIEWER);
        });

        it('then grant-only users are appended in a stable order', () => {
            const result = resolve(
                [],
                [
                    userGrant({ userUuid: 'user-c' }),
                    userGrant({ userUuid: 'user-a' }),
                    userGrant({ userUuid: 'user-b' }),
                ],
            );

            expect(result.map((entry) => entry.userUuid)).toEqual([
                'user-a',
                'user-b',
                'user-c',
            ]);
        });

        it('then existing space entries keep their original order', () => {
            const result = resolve(
                [
                    spaceEntry({ userUuid: 'user-z' }),
                    spaceEntry({ userUuid: 'user-y' }),
                ],
                [],
            );

            expect(result.map((entry) => entry.userUuid)).toEqual([
                'user-z',
                'user-y',
            ]);
        });
    });
});
