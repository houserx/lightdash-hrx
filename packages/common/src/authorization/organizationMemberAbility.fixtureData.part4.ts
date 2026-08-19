import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type FixtureEntry } from './organizationMemberAbility.fixtureData';

export const ORG_FIXTURE_PART_4: FixtureEntry[] = [
    // [207] interactive_viewer: cannot view savedCharts from another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '789', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [208] interactive_viewer: can view projects from their own organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [209] interactive_viewer: cannot view projects from another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [210] interactive_viewer: can view their own jobs
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'Job',
        resource: { userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce' },
        expected: true,
    },
    // [211] interactive_viewer: cannot view jobs from another user
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'Job',
        resource: { userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [212] interactive_viewer: can view AiAgent
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [213] interactive_viewer: cannot manage AiAgent
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [214] interactive_viewer: cannot view AiAgent from another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [215] interactive_viewer: can create AiAgentThread
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [216] interactive_viewer: can view only his own AiAgentThread
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
    // [217] interactive_viewer: cannot view other users AiAgentThread
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [218] interactive_viewer: cannot manage his own AiAgentThread
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: false,
    },
    // [219] interactive_viewer: cannot create AiAgentThread in another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [220] interactive_viewer: can create ScheduledDeliveries
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [221] interactive_viewer: can manage only his own ScheduledDeliveries
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
    // [222] interactive_viewer: cannot manage ScheduledDeliveries created by other users
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [223] interactive_viewer: cannot create ScheduledDeliveries in another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [224] admin: checks if users can create project in organization they belong to
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'DEFAULT' },
        expected: true,
    },
    // [225] admin: checks that users cannot create a project in another organization
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'DEFAULT' },
        expected: false,
    },
    // [226] admin: checks if users can create a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: true,
    },
    // [227] admin: checks that users cannot create a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [228] admin: checks if users can delete a project in organization they belong to
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [229] admin: checks that users cannot delete a project in another organization
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [230] admin: checks if users can delete a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: true,
    },
    // [231] admin: checks that users cannot delete a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [232] developer: checks if users can create project in organization they belong to
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'DEFAULT' },
        expected: false,
    },
    // [233] developer: checks that users cannot create a project in another organization
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'DEFAULT' },
        expected: false,
    },
    // [234] developer: checks if users can create a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: true,
    },
    // [235] developer: checks that users cannot create a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [236] developer: checks if users can delete a project in organization they belong to
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [237] developer: checks that users cannot delete a project in another organization
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [238] developer: checks if users can delete a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: true,
    },
    // [239] developer: checks that users cannot delete a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [240] member: checks if users can create project in organization they belong to
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'DEFAULT' },
        expected: false,
    },
    // [241] member: checks that users cannot create a project in another organization
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'DEFAULT' },
        expected: false,
    },
    // [242] member: checks if users can create a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [243] member: checks that users cannot create a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [244] member: checks if users can delete a project in organization they belong to
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [245] member: checks that users cannot delete a project in another organization
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [246] member: checks if users can delete a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [247] member: checks that users cannot delete a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.MEMBER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [248] viewer: checks if users can create project in organization they belong to
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'DEFAULT' },
        expected: false,
    },
    // [249] viewer: checks that users cannot create a project in another organization
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'DEFAULT' },
        expected: false,
    },
    // [250] viewer: checks if users can create a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [251] viewer: checks that users cannot create a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [252] viewer: checks if users can delete a project in organization they belong to
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [253] viewer: checks that users cannot delete a project in another organization
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [254] viewer: checks if users can delete a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [255] viewer: checks that users cannot delete a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [256] interactive_viewer: checks if users can create project in organization they belong to
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'DEFAULT' },
        expected: false,
    },
    // [257] interactive_viewer: checks that users cannot create a project in another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'DEFAULT' },
        expected: false,
    },
    // [258] interactive_viewer: checks if users can create a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [259] interactive_viewer: checks that users cannot create a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [260] interactive_viewer: checks if users can delete a project in organization they belong to
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [261] interactive_viewer: checks that users cannot delete a project in another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [262] interactive_viewer: checks if users can delete a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [263] interactive_viewer: checks that users cannot delete a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.INTERACTIVE_VIEWER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [264] editor: checks if users can create project in organization they belong to
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'DEFAULT' },
        expected: false,
    },
    // [265] editor: checks that users cannot create a project in another organization
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'DEFAULT' },
        expected: false,
    },
    // [266] editor: checks if users can create a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [267] editor: checks that users cannot create a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [268] editor: checks if users can delete a project in organization they belong to
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [269] editor: checks that users cannot delete a project in another organization
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [270] editor: checks if users can delete a PREVIEW project in organization they belong to
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '456', type: 'PREVIEW' },
        expected: false,
    },
    // [271] editor: checks that users cannot delete a PREVIEW project in another organization
    {
        role: OrganizationMemberRole.EDITOR,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'delete',
        subjectType: 'Project',
        resource: { organizationUuid: '789', type: 'PREVIEW' },
        expected: false,
    },
    // [272] admin: cannot create a personal access token as PAT is disabled
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: false,
                allowedOrgRoles: [
                    OrganizationMemberRole.MEMBER,
                    OrganizationMemberRole.VIEWER,
                    OrganizationMemberRole.INTERACTIVE_VIEWER,
                    OrganizationMemberRole.EDITOR,
                    OrganizationMemberRole.DEVELOPER,
                    OrganizationMemberRole.ADMIN,
                ],
            },
        },
        action: 'create',
        subjectType: 'PersonalAccessToken',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: false,
    },
    // [273] developer: cannot create a personal access token as PAT allowed roles dont match
    {
        role: OrganizationMemberRole.DEVELOPER,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [OrganizationMemberRole.ADMIN],
            },
        },
        action: 'create',
        subjectType: 'PersonalAccessToken',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: false,
    },
    // [274] admin: can create a personal access token as PAT is enabled
    {
        role: OrganizationMemberRole.ADMIN,
        permissionsConfig: {
            pat: {
                enabled: true,
                allowedOrgRoles: [OrganizationMemberRole.ADMIN],
            },
        },
        action: 'create',
        subjectType: 'PersonalAccessToken',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
];
