import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type FixtureEntry } from './organizationMemberAbility.fixtureData';

export const ORG_FIXTURE_PART_3: FixtureEntry[] = [
    // [138] viewer: can view and manage public & accessable space
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
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: true,
    },
    // [139] viewer: can view and manage public & accessable space
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
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'viewer',
                },
            ],
        },
        expected: false,
    },
    // [140] viewer: can view and manage public & accessable space
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
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: true,
    },
    // [141] viewer: can view and manage public & accessable space
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
            access: [
                {
                    userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
                    role: 'editor',
                },
            ],
        },
        expected: false,
    },
    // [142] viewer: can view member profiles
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
        subjectType: 'OrganizationMemberProfile',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [143] viewer: can create invitations
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
        subjectType: 'InviteLink',
        resource: {},
        expected: false,
    },
    // [144] viewer: cannot create a project in organization they belong to
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
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [145] viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [146] viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [147] viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [148] viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [149] viewer: cannot run SQL queries
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
        subjectType: 'SqlRunner',
        resource: {},
        expected: false,
    },
    // [150] viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [151] viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [152] viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [153] viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [154] viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [155] viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'InviteLink',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [156] viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [157] viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [158] viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [159] viewer: cannot delete any resource, except space when have editor space role
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
    // [160] viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [161] viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'InviteLink',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [162] viewer: can view their own organization
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
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [163] viewer: cannot view another organization
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
        subjectType: 'Organization',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [164] viewer: can view dashboards from their own organization
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
    // [165] viewer: cannot view dashboards from another organization
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
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [166] viewer: can view savedCharts from their own organization
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
    // [167] viewer: cannot view savedCharts from another organization
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
        resource: { organizationUuid: '789', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [168] viewer: can view projects from their own organization
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
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [169] viewer: cannot view projects from another organization
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
        subjectType: 'Project',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [170] viewer: can view their own jobs
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
        subjectType: 'Job',
        resource: { userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce' },
        expected: false,
    },
    // [171] viewer: cannot view jobs from another user
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
        subjectType: 'Job',
        resource: { userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [172] viewer: cannot view the SemanticViewer
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
        subjectType: 'SemanticViewer',
        resource: null,
        expected: false,
    },
    // [173] viewer: cannot view AiAgent
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
        subjectType: 'AiAgent',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [174] viewer: cannot manage AiAgent
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
        subjectType: 'AiAgent',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [175] viewer: can view only his own AiAgentThread
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
        subjectType: 'AiAgentThread',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: true,
    },
    // [176] viewer: cannot view other users AiAgentThread
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
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: false,
    },
    // [177] viewer: cannot manage his own AiAgentThread
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
        subjectType: 'AiAgentThread',
        resource: {
            organizationUuid: '456',
            userUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce',
        },
        expected: false,
    },
    // [178] viewer: cannot create AiAgentThread
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
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [179] viewer: cannot view AiAgentThread from another organization
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
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [180] viewer: cannot create ScheduledDeliveries
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
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [181] viewer: cannot manage ScheduledDeliveries
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
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [182] interactive_viewer: can view member profiles
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
        subjectType: 'OrganizationMemberProfile',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [183] interactive_viewer: can create invitations
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
        subjectType: 'InviteLink',
        resource: {},
        expected: false,
    },
    // [184] interactive_viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [185] interactive_viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [186] interactive_viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [187] interactive_viewer: cannot create any resource, except space when have editor space role
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
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [188] interactive_viewer: cannot run SQL queries
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
        subjectType: 'SqlRunner',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [189] interactive_viewer: cannot use the SemanticViewer
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
        subjectType: 'SemanticViewer',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [190] interactive_viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [191] interactive_viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [192] interactive_viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [193] interactive_viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Project',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [194] interactive_viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [195] interactive_viewer: cannot update any resource, except space when have editor space role
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
        action: 'update',
        subjectType: 'InviteLink',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [196] interactive_viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [197] interactive_viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [198] interactive_viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [199] interactive_viewer: cannot delete any resource, except space when have editor space role
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
    // [200] interactive_viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [201] interactive_viewer: cannot delete any resource, except space when have editor space role
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
        subjectType: 'InviteLink',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [202] interactive_viewer: can view their own organization
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
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [203] interactive_viewer: cannot view another organization
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
        subjectType: 'Organization',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [204] interactive_viewer: can view dashboards from their own organization
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [205] interactive_viewer: cannot view dashboards from another organization
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '789', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [206] interactive_viewer: can view savedCharts from their own organization
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
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
];
