import { ProjectMemberRole } from '../types/projectMemberRole';
import { type FixtureEntry } from './projectMemberAbility.fixtureData';

export const PROJECT_FIXTURE_PART_2: FixtureEntry[] = [
    // [111] developer: cannot manage ScheduledDeliveries created by other users
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [112] developer: cannot manage ScheduledDeliveries from another project
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [113] developer: can manage SourceCode on a non-protected branch
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'SourceCode',
        resource: {
            projectUuid: 'project-uuid-1234',
            isProtectedBranch: false,
        },
        expected: true,
    },
    // [114] developer: cannot manage SourceCode on a protected branch
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'manage',
        subjectType: 'SourceCode',
        resource: { projectUuid: 'project-uuid-1234', isProtectedBranch: true },
        expected: false,
    },
    // [115] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [116] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [117] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [118] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [119] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [120] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: false,
    },
    // [121] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [122] viewer: can only view public & accessable dashboards
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: false,
    },
    // [123] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [124] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [125] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [126] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [127] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [128] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: false,
    },
    // [129] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [130] viewer: can view and manage public & accessable saved charts
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: false,
    },
    // [131] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [132] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [133] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [134] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [],
        },
        expected: false,
    },
    // [135] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: true,
    },
    // [136] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'viewer' }],
        },
        expected: false,
    },
    // [137] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: true,
    },
    // [138] viewer: can view and manage public & accessable space
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
            access: [{ userUuid: 'user-uuid-1234', role: 'editor' }],
        },
        expected: false,
    },
    // [139] viewer: can view other public resources
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [140] viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [141] viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [142] viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [143] viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'Project',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [144] viewer: cannot manage resources
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [145] viewer: cannot manage resources
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Job',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [146] viewer: cannot manage resources
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'SqlRunner',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [147] viewer: cannot manage resources
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'SemanticViewer',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [148] viewer: can download CSV
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'ExportCsv',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [149] viewer: cannot change csv results
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'ChangeCsvResults',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [150] viewer: cannot Explore
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'Explore',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [151] viewer: cannot view underlying data
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'UnderlyingData',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [152] viewer: can view his own job status
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { createdByUserUuid: 'user-uuid-1234' },
        expected: true,
    },
    // [153] viewer: cannot view job status from the project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [154] viewer: cannot view job status from another project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'JobStatus',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [155] viewer: cannot view AiAgent
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [156] viewer: cannot manage AiAgent
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [157] viewer: can view only his own AiAgentThread
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [158] viewer: cannot view other users AiAgentThread
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [159] viewer: cannot manage his own AiAgentThread
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: false,
    },
    // [160] viewer: cannot create AiAgentThread
    {
        role: ProjectMemberRole.VIEWER,
        action: 'create',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [161] viewer: cannot view AiAgentThread from another project
    {
        role: ProjectMemberRole.VIEWER,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [162] viewer: cannot create ScheduledDeliveries
    {
        role: ProjectMemberRole.VIEWER,
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [163] viewer: cannot manage ScheduledDeliveries
    {
        role: ProjectMemberRole.VIEWER,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [164] interactive_viewer: can view public resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [165] interactive_viewer: can view public resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [166] interactive_viewer: can view public resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: true,
    },
    // [167] interactive_viewer: can view public resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [168] interactive_viewer: can view public resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'SemanticViewer',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [169] interactive_viewer: can not view private resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
        },
        expected: false,
    },
    // [170] interactive_viewer: can not view private resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
        },
        expected: false,
    },
    // [171] interactive_viewer: can not view private resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
        },
        expected: false,
    },
    // [172] interactive_viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'SavedChart',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [173] interactive_viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Dashboard',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [174] interactive_viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Space',
        resource: { projectUuid: '5678', inheritsFromOrgOrProject: true },
        expected: false,
    },
    // [175] interactive_viewer: cannot view resources from another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'Project',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [176] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [177] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [178] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: true,
        },
        expected: false,
    },
    // [179] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'SavedChart',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
        },
        expected: false,
    },
    // [180] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Dashboard',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
        },
        expected: false,
    },
    // [181] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Space',
        resource: {
            projectUuid: 'project-uuid-1234',
            inheritsFromOrgOrProject: false,
        },
        expected: false,
    },
    // [182] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Project',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [183] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Job',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [184] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'SqlRunner',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [185] interactive_viewer: cannot manage resources
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'SemanticViewer',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [186] interactive_viewer: can download CSV
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'ExportCsv',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [187] interactive_viewer: can Explore
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'Explore',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [188] interactive_viewer: can view underlying data
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'UnderlyingData',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [189] interactive_viewer: can view AiAgent
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [190] interactive_viewer: cannot manage AiAgent
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'AiAgent',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: false,
    },
    // [191] interactive_viewer: cannot view AiAgent from another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'AiAgent',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [192] interactive_viewer: can create AiAgentThread
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'create',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [193] interactive_viewer: can view only his own AiAgentThread
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [194] interactive_viewer: cannot view other users AiAgentThread
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'view',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [195] interactive_viewer: cannot manage his own AiAgentThread
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'AiAgentThread',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: false,
    },
    // [196] interactive_viewer: cannot create AiAgentThread in another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'create',
        subjectType: 'AiAgentThread',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [197] interactive_viewer: can create ScheduledDeliveries
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: 'project-uuid-1234' },
        expected: true,
    },
    // [198] interactive_viewer: can manage only his own ScheduledDeliveries
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'user-uuid-1234',
        },
        expected: true,
    },
    // [199] interactive_viewer: cannot manage ScheduledDeliveries created by other users
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'manage',
        subjectType: 'ScheduledDeliveries',
        resource: {
            projectUuid: 'project-uuid-1234',
            userUuid: 'another-user-uuid',
        },
        expected: false,
    },
    // [200] interactive_viewer: cannot create ScheduledDeliveries in another project
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'create',
        subjectType: 'ScheduledDeliveries',
        resource: { projectUuid: '5678' },
        expected: false,
    },
    // [201] admin: checks if user can create PREVIEW projects
    {
        role: ProjectMemberRole.ADMIN,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'PREVIEW' },
        expected: true,
    },
    // [202] admin: checks that users cannot create regular projects
    {
        role: ProjectMemberRole.ADMIN,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'DEFAULT' },
        expected: false,
    },
    // [203] admin: checks if user can delete their own PREVIEW projects
    {
        role: ProjectMemberRole.ADMIN,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
            type: 'PREVIEW',
        },
        expected: true,
    },
    // [204] admin: checks if user can delete other users PREVIEW projects
    {
        role: ProjectMemberRole.ADMIN,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: '1234',
            type: 'PREVIEW',
        },
        expected: true,
    },
    // [205] developer: checks if user can create PREVIEW projects
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'PREVIEW' },
        expected: true,
    },
    // [206] developer: checks that users cannot create regular projects
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'DEFAULT' },
        expected: false,
    },
    // [207] developer: checks if user can delete their own PREVIEW projects
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
            type: 'PREVIEW',
        },
        expected: true,
    },
    // [208] developer: checks if user can delete other users PREVIEW projects
    {
        role: ProjectMemberRole.DEVELOPER,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: '1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
    // [209] editor: checks if user can create PREVIEW projects
    {
        role: ProjectMemberRole.EDITOR,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'PREVIEW' },
        expected: false,
    },
    // [210] editor: checks that users cannot create regular projects
    {
        role: ProjectMemberRole.EDITOR,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'DEFAULT' },
        expected: false,
    },
    // [211] editor: checks if user can delete their own PREVIEW projects
    {
        role: ProjectMemberRole.EDITOR,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
    // [212] editor: checks if user can delete other users PREVIEW projects
    {
        role: ProjectMemberRole.EDITOR,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: '1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
    // [213] interactive_viewer: checks if user can create PREVIEW projects
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'PREVIEW' },
        expected: false,
    },
    // [214] interactive_viewer: checks that users cannot create regular projects
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'DEFAULT' },
        expected: false,
    },
    // [215] interactive_viewer: checks if user can delete their own PREVIEW projects
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
    // [216] interactive_viewer: checks if user can delete other users PREVIEW projects
    {
        role: ProjectMemberRole.INTERACTIVE_VIEWER,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: '1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
    // [217] viewer: checks if user can create PREVIEW projects
    {
        role: ProjectMemberRole.VIEWER,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'PREVIEW' },
        expected: false,
    },
    // [218] viewer: checks that users cannot create regular projects
    {
        role: ProjectMemberRole.VIEWER,
        action: 'create',
        subjectType: 'Project',
        resource: { upstreamProjectUuid: 'project-uuid-1234', type: 'DEFAULT' },
        expected: false,
    },
    // [219] viewer: checks if user can delete their own PREVIEW projects
    {
        role: ProjectMemberRole.VIEWER,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: 'user-uuid-1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
    // [220] viewer: checks if user can delete other users PREVIEW projects
    {
        role: ProjectMemberRole.VIEWER,
        action: 'delete',
        subjectType: 'Project',
        resource: {
            projectUuid: 'project-uuid-1234',
            createdByUserUuid: '1234',
            type: 'PREVIEW',
        },
        expected: false,
    },
];
