import { Ability, AbilityBuilder } from '@casl/ability';
import {
    ORGANIZATION_SYSTEM_ROLE_UUIDS,
    OrganizationMemberRole,
    type MemberAbility,
    type SessionUser,
} from '@lightdash/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RolesModel } from '../models/RolesModel';
import {
    getOrganizationSystemRoleScopes,
    validateOrganizationScopesCanBeGranted,
} from './organizationRolePermissions';

describe('getOrganizationSystemRoleScopes', () => {
    it('prefers scoped_roles scopes over the literal map for the well-known org role_uuid', async () => {
        const wellKnownUuid =
            ORGANIZATION_SYSTEM_ROLE_UUIDS[OrganizationMemberRole.MEMBER];
        const rolesModel = {
            getScopesByRoleUuid: vi.fn(async (roleUuid: string) =>
                roleUuid === wellKnownUuid
                    ? ['manage:Organization']
                    : undefined,
            ),
        } as unknown as RolesModel;

        const permissions = await getOrganizationSystemRoleScopes(
            OrganizationMemberRole.MEMBER,
            rolesModel,
        );

        expect(rolesModel.getScopesByRoleUuid).toHaveBeenCalledWith(
            wellKnownUuid,
        );
        expect(permissions).toEqual(['manage:Organization']);
    });

    it('falls back to the literal map when scoped_roles has no row for the well-known uuid', async () => {
        const rolesModel = {
            getScopesByRoleUuid: vi.fn().mockResolvedValue(undefined),
        } as unknown as RolesModel;

        const permissions = await getOrganizationSystemRoleScopes(
            OrganizationMemberRole.MEMBER,
            rolesModel,
        );

        expect(permissions).toContain('view:OrganizationMemberProfile');
    });
});

const ORG = 'org-1';
const CUSTOM_ROLE = 'custom-org-manager';

// `pat.allowedOrgRoles` defaults to every organization role, so on a default
// instance the ability builder hands this to custom-role members too. It is
// never listed in `scoped_roles`, which is exactly why it needs its own case.
const customRoleCaller = ({
    canManagePersonalAccessToken,
}: {
    canManagePersonalAccessToken: boolean;
}): SessionUser => {
    const { build, can } = new AbilityBuilder<MemberAbility>(Ability);
    can('manage', 'Organization', { organizationUuid: ORG });
    if (canManagePersonalAccessToken) {
        can('manage', 'PersonalAccessToken');
    }

    return {
        userUuid: 'caller',
        organizationUuid: ORG,
        role: OrganizationMemberRole.MEMBER,
        roleUuid: CUSTOM_ROLE,
        ability: build(),
    } as never;
};

// getScopesByRoleUuid always resolves undefined -- no scoped_roles row to
// prefer, so getOrganizationSystemRoleScopes falls back to the literal map
// (the only behavior that existed before A15b's DB-first resolution).
const rolesModelWithScopes = (scopes: string[]) =>
    ({
        getRoleWithScopesByUuid: vi.fn().mockResolvedValue({
            roleUuid: CUSTOM_ROLE,
            organizationUuid: ORG,
            level: 'organization',
            scopes,
        }),
        getScopesByRoleUuid: vi.fn().mockResolvedValue(undefined),
    }) as unknown as RolesModel;

describe('validateOrganizationScopesCanBeGranted', () => {
    let managerScopes: string[];

    beforeAll(async () => {
        managerScopes = [
            'manage:Organization',
            'manage:OrganizationMemberProfile',
            ...(await getOrganizationSystemRoleScopes(
                OrganizationMemberRole.MEMBER,
                rolesModelWithScopes([]),
            )),
        ];
    });

    it('lets a custom-role caller grant a system role while personal access tokens are enabled', async () => {
        await expect(
            validateOrganizationScopesCanBeGranted({
                user: customRoleCaller({
                    canManagePersonalAccessToken: true,
                }),
                organizationUuid: ORG,
                grantedScopes: await getOrganizationSystemRoleScopes(
                    OrganizationMemberRole.MEMBER,
                    rolesModelWithScopes(managerScopes),
                    { includePersonalAccessToken: true },
                ),
                rolesModel: rolesModelWithScopes(managerScopes),
            }),
        ).resolves.toBeUndefined();
    });

    it('still rejects a system role the custom-role caller does not cover', async () => {
        await expect(
            validateOrganizationScopesCanBeGranted({
                user: customRoleCaller({
                    canManagePersonalAccessToken: true,
                }),
                organizationUuid: ORG,
                grantedScopes: await getOrganizationSystemRoleScopes(
                    OrganizationMemberRole.ADMIN,
                    rolesModelWithScopes(managerScopes),
                    { includePersonalAccessToken: true },
                ),
                rolesModel: rolesModelWithScopes(managerScopes),
            }),
        ).rejects.toThrow('Cannot grant permissions exceeding your own');
    });

    it('rejects a caller that carries no organization', async () => {
        const orgless = customRoleCaller({
            canManagePersonalAccessToken: true,
        });
        delete (orgless as { organizationUuid?: string }).organizationUuid;

        await expect(
            validateOrganizationScopesCanBeGranted({
                user: orgless,
                organizationUuid: ORG,
                grantedScopes: await getOrganizationSystemRoleScopes(
                    OrganizationMemberRole.MEMBER,
                    rolesModelWithScopes(managerScopes),
                ),
                rolesModel: rolesModelWithScopes(managerScopes),
            }),
        ).rejects.toThrow('You do not have permission');
    });

    it('rejects a caller belonging to a different organization', async () => {
        await expect(
            validateOrganizationScopesCanBeGranted({
                user: {
                    ...customRoleCaller({ canManagePersonalAccessToken: true }),
                    organizationUuid: 'some-other-org',
                } as never,
                organizationUuid: ORG,
                grantedScopes: await getOrganizationSystemRoleScopes(
                    OrganizationMemberRole.MEMBER,
                    rolesModelWithScopes(managerScopes),
                ),
                rolesModel: rolesModelWithScopes(managerScopes),
            }),
        ).rejects.toThrow('You do not have permission');
    });

    it('does not lend the caller a token permission it was never granted', async () => {
        await expect(
            validateOrganizationScopesCanBeGranted({
                user: customRoleCaller({
                    canManagePersonalAccessToken: false,
                }),
                organizationUuid: ORG,
                grantedScopes: ['manage:PersonalAccessToken'],
                rolesModel: rolesModelWithScopes(managerScopes),
            }),
        ).rejects.toThrow('Cannot grant permissions exceeding your own');
    });
});
