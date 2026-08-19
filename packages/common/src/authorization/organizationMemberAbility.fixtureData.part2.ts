import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type FixtureEntry } from './organizationMemberAbility.fixtureData';

export const ORG_FIXTURE_PART_2: FixtureEntry[] = [
    // [69] editor: can view and manage public & accessable space
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
        action: 'manage',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [70] editor: can view and manage public & accessable space
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
        action: 'view',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: true,
    },
    // [71] editor: can view and manage public & accessable space
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
        action: 'manage',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: false,
    },
    // [72] editor: can view and manage public & accessable space
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
        action: 'view',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: true,
    },
    // [73] editor: can view and manage public & accessable space
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
        action: 'manage',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: false,
    },
    // [74] editor: can view and manage public & accessable space
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
        action: 'manage',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'admin',
                },
            ],
        },
        expected: true,
    },
    // [75] editor: can manage public dashboards from their own organization
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: true,
            access: [],
        },
        expected: false,
    },
    // [76] editor: cannot manage public dashboards from another organization
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '789',
            inheritsFromOrgOrProject: true,
            access: [],
        },
        expected: false,
    },
    // [77] editor: can view member profiles
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
        action: 'view',
        subjectType: 'OrganizationMemberProfile',
        resource: null,
        expected: true,
    },
    // [78] editor: can create invite links
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
        subjectType: 'InviteLink',
        resource: null,
        expected: false,
    },
    // [79] editor: cannot run SQL Queries
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
        action: 'manage',
        subjectType: 'SqlRunner',
        resource: null,
        expected: false,
    },
    // [80] editor: cannot view compiled SQL
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
        action: 'view',
        subjectType: 'CompiledSql',
        resource: null,
        expected: false,
    },
    // [81] editor: can use the SemanticViewer
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
        action: 'manage',
        subjectType: 'SemanticViewer',
        resource: null,
        expected: true,
    },
    // [82] editor: can view his own job status
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { createdByUserUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce' },
        expected: true,
    },
    // [83] editor: cannot view job status from the organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [84] editor: cannot view job status from another organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '54678' },
        expected: false,
    },
    // [85] editor: can create ScheduledDeliveries
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
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [86] editor: can manage only his own ScheduledDeliveries
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
    // [87] editor: cannot manage ScheduledDeliveries created by other users
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [88] editor: cannot manage ScheduledDeliveries from another organization
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [89] developer: can create content as code through manage
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
        subjectType: 'ContentAsCode',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [90] developer: can run SQL Queries
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
        action: 'manage',
        subjectType: 'SqlRunner',
        resource: null,
        expected: true,
    },
    // [91] developer: can view compiled SQL
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
        action: 'view',
        subjectType: 'CompiledSql',
        resource: null,
        expected: true,
    },
    // [92] developer: can use the SemanticViewer
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
        action: 'manage',
        subjectType: 'SemanticViewer',
        resource: null,
        expected: true,
    },
    // [93] developer: can view his own job status
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { createdByUserUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce' },
        expected: true,
    },
    // [94] developer: cannot view job status from the organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [95] developer: cannot view job status from another organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '54678' },
        expected: false,
    },
    // [96] developer: can manage AiAgent
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
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [97] developer: cannot manage AiAgent from another organization
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
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [98] developer: can manage only his own AiAgentThread
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
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
    // [99] developer: cannot manage other users AiAgentThread
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
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [100] developer: cannot manage AiAgentThread from another organization
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
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [101] developer: can create ScheduledDeliveries
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
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [102] developer: can manage only his own ScheduledDeliveries
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
    // [103] developer: cannot manage ScheduledDeliveries created by other users
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [104] developer: cannot manage ScheduledDeliveries from another organization
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [105] developer: can promote charts in spaces with admin access
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
        action: 'promote',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'admin',
                },
            ],
        },
        expected: true,
    },
    // [106] developer: can promote charts in spaces with editor access
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
        action: 'promote',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: true,
    },
    // [107] developer: cannot promote charts in spaces with viewer access
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
        action: 'promote',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: false,
    },
    // [108] developer: can promote dashboards in spaces with admin access
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
        action: 'promote',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'admin',
                },
            ],
        },
        expected: true,
    },
    // [109] developer: can promote dashboards in spaces with editor access
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
        action: 'promote',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: true,
    },
    // [110] developer: cannot promote dashboards in spaces with viewer access
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
        action: 'promote',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: false,
    },
    // [111] member: can view member profiles
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
        action: 'view',
        subjectType: 'OrganizationMemberProfile',
        resource: null,
        expected: true,
    },
    // [112] member: can create invitations
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
        subjectType: 'InviteLink',
        resource: null,
        expected: false,
    },
    // [113] member: cannot view organizations
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
        action: 'view',
        subjectType: 'Organization',
        resource: null,
        expected: false,
    },
    // [114] member: cannot view charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: null,
        expected: false,
    },
    // [115] member: can view his own job status
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { createdByUserUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce' },
        expected: true,
    },
    // [116] member: cannot view job status from the organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [117] member: cannot view job status from another organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '54678' },
        expected: false,
    },
    // [118] viewer: can only view public & accessable dashboards
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
        action: 'view',
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [119] viewer: can only view public & accessable dashboards
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [120] viewer: can only view public & accessable dashboards
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
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [121] viewer: can only view public & accessable dashboards
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [122] viewer: can only view public & accessable dashboards
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
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: true,
    },
    // [123] viewer: can only view public & accessable dashboards
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: false,
    },
    // [124] viewer: can only view public & accessable dashboards
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
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: true,
    },
    // [125] viewer: can only view public & accessable dashboards
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: false,
    },
    // [126] viewer: can view and manage public & accessable saved charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [127] viewer: can view and manage public & accessable saved charts
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
        action: 'manage',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [128] viewer: can view and manage public & accessable saved charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [129] viewer: can view and manage public & accessable saved charts
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
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [130] viewer: can view and manage public & accessable saved charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: true,
    },
    // [131] viewer: can view and manage public & accessable saved charts
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
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: false,
    },
    // [132] viewer: can view and manage public & accessable saved charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: true,
    },
    // [133] viewer: can view and manage public & accessable saved charts
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
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: false,
    },
    // [134] viewer: can view and manage public & accessable space
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
        action: 'view',
        subjectType: 'Space',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [135] viewer: can view and manage public & accessable space
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
        action: 'manage',
        subjectType: 'Space',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [136] viewer: can view and manage public & accessable space
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
        action: 'view',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [137] viewer: can view and manage public & accessable space
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
        action: 'manage',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
];
