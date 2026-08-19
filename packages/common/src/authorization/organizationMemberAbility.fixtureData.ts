import { type OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type AbilityAction, type CaslSubjectNames } from './types';

export type FixtureEntry = {
    role: OrganizationMemberRole;
    permissionsConfig: {
        pat: { enabled: boolean; allowedOrgRoles: OrganizationMemberRole[] };
    };
    action: AbilityAction;
    subjectType: CaslSubjectNames;
    resource: Record<string, unknown> | null;
    expected: boolean;
};

// Must match ORGANIZATION_MEMBER in organizationMemberAbility.mock.ts, since
// captured resource literals (e.g. organizationUuid: '456') were generated
// against that exact member context -- any placeholder value here breaks
// every condition that checks org/user-uuid equality on both paths.
export const ORG_UUID = '456';
export const USER_UUID = 'b264d83a-9000-426a-85ec-3f9c20f368ce';
