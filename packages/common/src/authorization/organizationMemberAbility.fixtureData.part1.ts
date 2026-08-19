import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type FixtureEntry } from './organizationMemberAbility.fixtureData';

export const ORG_FIXTURE_PART_1: FixtureEntry[] = [
    // [0] admin: allows only admins to view their organization roadmap
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
        action: 'view',
        subjectType: 'Roadmap',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [1] admin: allows only admins to view their organization roadmap
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
        action: 'view',
        subjectType: 'Roadmap',
        resource: { organizationUuid: 'another-organization' },
        expected: false,
    },
    // [2] member: allows only admins to view their organization roadmap
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
        subjectType: 'Roadmap',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [3] admin: can manage organizations
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
        action: 'manage',
        subjectType: 'Organization',
        resource: null,
        expected: true,
    },
    // [4] admin: cannot manage another organization
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
        action: 'manage',
        subjectType: 'Organization',
        resource: { organizationUuid: '789' },
        expected: false,
    },
    // [5] admin: can manage their own organization
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
        action: 'manage',
        subjectType: 'Organization',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [6] admin: can manage member profiles
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
        action: 'manage',
        subjectType: 'OrganizationMemberProfile',
        resource: null,
        expected: true,
    },
    // [7] admin: cannot manage other members from another organization
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
        action: 'manage',
        subjectType: 'OrganizationMemberProfile',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [8] admin: cannot manage other members from another organization
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
        action: 'manage',
        subjectType: 'OrganizationMemberProfile',
        resource: { organizationUuid: 'notmine' },
        expected: false,
    },
    // [9] admin: can view and manage all kinds of dashboards
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
        action: 'view',
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [10] admin: can view and manage all kinds of dashboards
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [11] admin: can view and manage all kinds of dashboards
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
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [12] admin: can view and manage all kinds of dashboards
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
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [13] admin: can view and manage all kinds of dashboards
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
    // [14] admin: can view and manage all kinds of dashboards
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
        expected: true,
    },
    // [15] admin: can view and manage all kinds of dashboards
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
    // [16] admin: can view and manage all kinds of dashboards
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
        expected: true,
    },
    // [17] admin: can view and manage all kinds of saved charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [18] admin: can view and manage all kinds of saved charts
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
        action: 'manage',
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [19] admin: can view and manage all kinds of saved charts
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
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [20] admin: can view and manage all kinds of saved charts
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
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [21] admin: can view and manage all kinds of saved charts
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
    // [22] admin: can view and manage all kinds of saved charts
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
        expected: true,
    },
    // [23] admin: can view and manage all kinds of saved charts
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
    // [24] admin: can view and manage all kinds of saved charts
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
        expected: true,
    },
    // [25] admin: can view and manage all kinds of space
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
        action: 'view',
        subjectType: 'Space',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [26] admin: can view and manage all kinds of space
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
        action: 'manage',
        subjectType: 'Space',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [27] admin: can view and manage all kinds of space
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
        action: 'view',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [28] admin: can view and manage all kinds of space
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
        action: 'manage',
        subjectType: 'Space',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [29] admin: can view and manage all kinds of space
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
    // [30] admin: can view and manage all kinds of space
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
        expected: true,
    },
    // [31] admin: can view and manage all kinds of space
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
    // [32] admin: can view and manage all kinds of space
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
        expected: true,
    },
    // [33] admin: can view his own job status
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { createdByUserUuid: 'b264d83a-9000-426a-85ec-3f9c20f368ce' },
        expected: true,
    },
    // [34] admin: cannot view job status from the organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [35] admin: cannot view job status from another organization
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
        action: 'view',
        subjectType: 'JobStatus',
        resource: { organizationUuid: '54678' },
        expected: false,
    },
    // [36] admin: can manage AiAgent
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
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [37] admin: cannot manage AiAgent from another organization
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
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [38] admin: can view all AiAgentThreads in the organization
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
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [39] admin: can manage all AiAgentThreads in the organization
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
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [40] admin: cannot view AiAgentThread from another organization
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
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [41] admin: cannot manage AiAgentThread from another organization
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
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [42] admin: can create ScheduledDeliveries
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
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [43] admin: can manage all ScheduledDeliveries
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [44] admin: can manage ScheduledDeliveries created by other users
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '456', userUuid: 'another-user-uuid' },
        expected: true,
    },
    // [45] admin: cannot manage ScheduledDeliveries from another organization
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
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { organizationUuid: '5678' },
        expected: false,
    },
    // [46] editor: can create but cannot manage content as code
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
        subjectType: 'ContentAsCode',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [47] editor: can create but cannot manage content as code
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
        subjectType: 'ContentAsCode',
        resource: { organizationUuid: '456' },
        expected: false,
    },
    // [48] editor: cannot manage organizations
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
        subjectType: 'Organization',
        resource: null,
        expected: false,
    },
    // [49] editor: can view and manage public & accessable dashboards
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
        subjectType: 'Dashboard',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [50] editor: can view and manage public & accessable dashboards
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
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [51] editor: can view and manage public & accessable dashboards
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
        subjectType: 'Dashboard',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [52] editor: can view and manage public & accessable dashboards
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
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [53] editor: can view and manage public & accessable dashboards
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
    // [54] editor: can view and manage public & accessable dashboards
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
    // [55] editor: can view and manage public & accessable dashboards
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
    // [56] editor: can view and manage public & accessable dashboards
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
    // [57] editor: can view and manage public & accessable saved charts
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
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [58] editor: can view and manage public & accessable saved charts
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
        subjectType: 'SavedChart',
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [59] editor: can view and manage public & accessable saved charts
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
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [60] editor: can view and manage public & accessable saved charts
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
        subjectType: 'SavedChart',
        resource: {
            organizationUuid: '456',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [61] editor: can view and manage public & accessable saved charts
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
    // [62] editor: can view and manage public & accessable saved charts
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
    // [63] editor: can view and manage public & accessable saved charts
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
    // [64] editor: can view and manage public & accessable saved charts
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
    // [65] editor: can create a space
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
        subjectType: 'Space',
        resource: { organizationUuid: '456' },
        expected: true,
    },
    // [66] editor: can view and manage public & accessable space
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
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [67] editor: can view and manage public & accessable space
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
        resource: { organizationUuid: '456', inheritsFromOrgOrProject: true },
        expected: true,
    },
    // [68] editor: can view and manage public & accessable space
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
            access: [],
        },
        expected: false,
    },
];
