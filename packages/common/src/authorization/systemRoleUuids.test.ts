import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { ProjectMemberRole } from '../types/projectMemberRole';
import {
    ORGANIZATION_SYSTEM_ROLE_UUIDS,
    PROJECT_SYSTEM_ROLE_UUIDS,
    resolveEffectiveOrgRoleUuid,
    resolveEffectiveProjectRoleUuid,
} from './systemRoleUuids';

describe('resolveEffectiveOrgRoleUuid', () => {
    it('returns the membership role_uuid when a custom role is assigned', () => {
        expect(
            resolveEffectiveOrgRoleUuid({
                role: OrganizationMemberRole.MEMBER,
                roleUuid: 'custom-role-uuid',
            }),
        ).toBe('custom-role-uuid');
    });

    it.each(Object.values(OrganizationMemberRole))(
        'falls back to the well-known system-role uuid for %s when roleUuid is unset',
        (role) => {
            expect(
                resolveEffectiveOrgRoleUuid({ role, roleUuid: undefined }),
            ).toBe(ORGANIZATION_SYSTEM_ROLE_UUIDS[role]);
        },
    );

    it('falls back to the well-known system-role uuid when roleUuid is null', () => {
        expect(
            resolveEffectiveOrgRoleUuid({
                role: OrganizationMemberRole.ADMIN,
                roleUuid: null,
            }),
        ).toBe(ORGANIZATION_SYSTEM_ROLE_UUIDS[OrganizationMemberRole.ADMIN]);
    });

    it('covers every OrganizationMemberRole with a distinct well-known uuid', () => {
        const roles = Object.values(OrganizationMemberRole);
        const uuids = roles.map((role) => ORGANIZATION_SYSTEM_ROLE_UUIDS[role]);
        expect(new Set(uuids).size).toBe(roles.length);
    });
});

describe('resolveEffectiveProjectRoleUuid', () => {
    it('returns the membership role_uuid when a custom role is assigned', () => {
        expect(
            resolveEffectiveProjectRoleUuid({
                role: ProjectMemberRole.VIEWER,
                roleUuid: 'custom-role-uuid',
            }),
        ).toBe('custom-role-uuid');
    });

    it.each(Object.values(ProjectMemberRole))(
        'falls back to the well-known system-role uuid for %s when roleUuid is unset',
        (role) => {
            expect(
                resolveEffectiveProjectRoleUuid({ role, roleUuid: undefined }),
            ).toBe(PROJECT_SYSTEM_ROLE_UUIDS[role]);
        },
    );

    it('falls back to the well-known system-role uuid when roleUuid is null', () => {
        expect(
            resolveEffectiveProjectRoleUuid({
                role: ProjectMemberRole.ADMIN,
                roleUuid: null,
            }),
        ).toBe(PROJECT_SYSTEM_ROLE_UUIDS[ProjectMemberRole.ADMIN]);
    });

    it('covers every ProjectMemberRole with a distinct well-known uuid', () => {
        const roles = Object.values(ProjectMemberRole);
        const uuids = roles.map((role) => PROJECT_SYSTEM_ROLE_UUIDS[role]);
        expect(new Set(uuids).size).toBe(roles.length);
    });

    it('org and project well-known uuids never collide with each other', () => {
        const orgUuids = Object.values(ORGANIZATION_SYSTEM_ROLE_UUIDS);
        const projectUuids = Object.values(PROJECT_SYSTEM_ROLE_UUIDS);
        const combined = new Set([...orgUuids, ...projectUuids]);
        expect(combined.size).toBe(orgUuids.length + projectUuids.length);
    });
});
