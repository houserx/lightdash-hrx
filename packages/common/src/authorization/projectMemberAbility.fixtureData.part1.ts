import { ProjectMemberRole } from '../types/projectMemberRole';
import { type FixtureEntry } from './projectMemberAbility.fixtureData';

export const PROJECT_FIXTURE_PART_1: FixtureEntry[] = [
    // [0] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [1] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [2] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [3] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [4] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [5] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [6] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [7] admin: can view and manage all kinds of dashboards
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [8] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [9] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [10] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [11] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [12] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [13] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [14] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [15] admin: can view and manage all kinds of saved charts
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [16] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [17] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [18] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [19] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: true,
    },
    // [20] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [21] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [22] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [23] admin: can view and manage all kinds of space
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [24] admin: can manage other types of public resources
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [25] admin: can manage other types of public resources
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'Job',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [26] admin: cannot view resources from another projectUuid
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'SavedChart',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [27] admin: cannot view resources from another projectUuid
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Dashboard',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [28] admin: cannot view resources from another projectUuid
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Space',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [29] admin: cannot view resources from another projectUuid
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'Project',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [30] admin: can view his own job status
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { createdByUserUuid: 'user-uuid-1234' },
        expected: true,
    },
    // [31] admin: can view job status from another user
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'JobStatus',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'another-admin-user-4567',
        },
        expected: true,
    },
    // [32] admin: can view job status from the project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [33] admin: cannot view job status from another project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [34] admin: cannot view job status with undefined details
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'JobStatus',
        resource: {},
        expected: false,
    },
    // [35] admin: can manage AiAgent
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [36] admin: cannot manage AiAgent from another project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [37] admin: can view all AiAgentThreads in the project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [38] admin: can manage all AiAgentThreads in the project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [39] admin: cannot view AiAgentThread from another project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [40] admin: cannot manage AiAgentThread from another project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [41] admin: can create ScheduledDeliveries
    {
        role: ProjectMemberRole.ADMIN,
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [42] admin: can manage all ScheduledDeliveries
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [43] admin: can manage ScheduledDeliveries created by other users
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: true,
    },
    // [44] admin: cannot manage ScheduledDeliveries from another project
    {
        role: ProjectMemberRole.ADMIN,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [45] editor: can create but cannot manage content as code
    {
        role: ProjectMemberRole.EDITOR,
        action: 'create',
        subjectType: 'ContentAsCode',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [46] editor: can create but cannot manage content as code
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'ContentAsCode',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [47] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [48] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [49] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [50] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [51] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [52] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: false,
    },
    // [53] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [54] editor: can view and manage public & accessible dashboards
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [55] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [56] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [57] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [58] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [59] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [60] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: false,
    },
    // [61] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [62] editor: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [63] editor: can create a space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'create',
        subjectType: 'Space',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [64] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [65] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [66] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [67] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [68] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [69] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: false,
    },
    // [70] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [71] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: false,
    },
    // [72] editor: can view and manage public & accessable space
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'admin' }],
        },
        expected: true,
    },
    // [73] editor: can view other public resources
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [74] editor: can manage other public resources
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Job',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [75] editor: cannot manage projects
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [76] editor: can download CSV
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'ExportCsv',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [77] editor: can change csv results
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'ChangeCsvResults',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [78] editor: cannot use SQL runner
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'SqlRunner',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [79] editor: cannot view compiled SQL
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'CompiledSql',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [80] editor: can use the SemanticViewer
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'SemanticViewer',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [81] editor: can view his own job status
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'JobStatus',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [82] editor: cannot view job status from the project
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [83] editor: cannot view job status from another project
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [84] editor: can view AiAgent
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [85] editor: cannot manage AiAgent
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [86] editor: cannot view AiAgent from another project
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'AiAgent',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [87] editor: can view only his own AiAgentThread
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [88] editor: can manage only his own AiAgentThread
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [89] editor: cannot view other users AiAgentThread
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [90] editor: cannot manage other users AiAgentThread
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [91] editor: cannot view AiAgentThread from another project
    {
        role: ProjectMemberRole.EDITOR,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [92] editor: can create ScheduledDeliveries
    {
        role: ProjectMemberRole.EDITOR,
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [93] editor: can manage only his own ScheduledDeliveries
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [94] editor: cannot manage ScheduledDeliveries created by other users
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [95] editor: cannot manage ScheduledDeliveries from another project
    {
        role: ProjectMemberRole.EDITOR,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [96] developer: can create content as code through manage
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'create',
        subjectType: 'ContentAsCode',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [97] developer: can use SQL runner
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'SqlRunner',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [98] developer: can view compiled SQL
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'view',
        subjectType: 'CompiledSql',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [99] developer: can use the SemanticViewer
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'view',
        subjectType: 'SemanticViewer',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [100] developer: can view his own job status
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [101] developer: can view job status from another user
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'admin-user-uuid-4567',
        },
        expected: true,
    },
    // [102] developer: can view job status from the project
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [103] developer: cannot view job status from another project
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [104] developer: can manage AiAgent
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [105] developer: cannot manage AiAgent from another project
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [106] developer: can manage only his own AiAgentThread
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [107] developer: cannot manage other users AiAgentThread
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [108] developer: cannot manage AiAgentThread from another project
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [109] developer: can create ScheduledDeliveries
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [110] developer: can manage only his own ScheduledDeliveries
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
];
