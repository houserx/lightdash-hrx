import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { ProjectMemberRole } from '../types/projectMemberRole';

/**
 * Well-known role_uuid values for every built-in system role, matching the
 * literal rows seeded by
 * packages/backend/src/database/migrations/20260818090000_seed_system_roles.ts
 * exactly. These are the *only* deliberately-duplicated data in this
 * refactor -- kept here, not derived from the migration, because migrations
 * must stay frozen and independent of live application code (see
 * migrations/CLAUDE.md), while this resolver needs to run at request time.
 *
 * A membership row with no role_uuid set is assigned one of these system
 * roles implicitly, by `role` string alone -- resolveEffective*RoleUuid
 * below makes that assignment explicit and queryable against `scoped_roles`
 * the same way a real custom-role assignment already is.
 */
export const ORGANIZATION_SYSTEM_ROLE_UUIDS: Record<
    OrganizationMemberRole,
    string
> = {
    [OrganizationMemberRole.MEMBER]: 'caaf4f7b-e3dc-4ea7-bf9d-9be284c223f6',
    [OrganizationMemberRole.VIEWER]: '8e4cd2c9-c7f5-486e-8cac-d64866fa15c1',
    [OrganizationMemberRole.INTERACTIVE_VIEWER]:
        'e81a9b0c-6a08-44ad-baab-2f5a899cc3ed',
    [OrganizationMemberRole.EDITOR]: 'cde89f4f-f971-4f7b-9d18-5b6082eb5ae0',
    [OrganizationMemberRole.DEVELOPER]: '76ce1b01-74e2-475a-b05d-7fa8ba4590c1',
    [OrganizationMemberRole.ADMIN]: '0afcdc72-2c59-4873-949e-92bbd5a78e97',
};

export const PROJECT_SYSTEM_ROLE_UUIDS: Record<ProjectMemberRole, string> = {
    [ProjectMemberRole.VIEWER]: '1cfe77eb-6715-4d8c-8e9f-92af4960b5c4',
    [ProjectMemberRole.INTERACTIVE_VIEWER]:
        'a6dd3176-8f48-442c-90dd-066d3d624fcf',
    [ProjectMemberRole.EDITOR]: '1ba5dc14-43c0-4f23-a7ff-4e25543cdb06',
    [ProjectMemberRole.DEVELOPER]: '324a01ee-a679-4559-90a4-99c70ef467eb',
    [ProjectMemberRole.ADMIN]: '63718c68-6e0b-404c-9e92-101513beb7fb',
};

/**
 * Resolves the role_uuid that effectively governs an organization
 * membership: its own role_uuid if a custom role is assigned, otherwise the
 * well-known uuid for its system `role`. No existing row is ever written to
 * -- this is a pure read-time resolution, not a backfill.
 */
export const resolveEffectiveOrgRoleUuid = (membership: {
    role: OrganizationMemberRole;
    roleUuid?: string | null;
}): string =>
    membership.roleUuid ?? ORGANIZATION_SYSTEM_ROLE_UUIDS[membership.role];

/** Project-level counterpart of resolveEffectiveOrgRoleUuid. */
export const resolveEffectiveProjectRoleUuid = (membership: {
    role: ProjectMemberRole;
    roleUuid?: string | null;
}): string => membership.roleUuid ?? PROJECT_SYSTEM_ROLE_UUIDS[membership.role];
