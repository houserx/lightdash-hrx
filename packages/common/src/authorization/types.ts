import { type Ability, type ForcedSubject } from '@casl/ability';
import { type OrganizationMemberProfile } from '../types/organizationMemberProfile';

export type AbilityAction =
    | 'create'
    | 'delete'
    | 'export'
    | 'impersonate'
    | 'manage'
    | 'promote'
    | 'update'
    | 'view';

export const VIEWER_EMBED_SUBJECTS = [
    'EmbedDashboardFilters',
    'EmbedDashboardFilterAddition',
    'EmbedDashboardParameters',
    'EmbedCsvExport',
    'EmbedDashboardCsvExport',
    'EmbedImageExport',
    'EmbedPagePdfExport',
    'EmbedDateZoom',
] as const satisfies readonly CaslSubjectNames[];

export const INTERACTIVE_VIEWER_EMBED_SUBJECTS = [
    'EmbedAiAgent',
    'EmbedAiAgentDebug',
    'EmbedExplore',
    'EmbedUnderlyingData',
    'EmbedDataApps',
] as const satisfies readonly CaslSubjectNames[];

export const DEVELOPER_EMBED_SUBJECTS = [
    'EmbedCompiledSql',
] as const satisfies readonly CaslSubjectNames[];

/** Alerting subjects: project viewers view all of them; developers manage all. */
export const ALERTING_SUBJECTS = [
    'AlertRule',
    'ContactPoint',
    'NotificationRoute',
] as const satisfies readonly CaslSubjectNames[];

/** Alerting subjects editors manage (rules only; contact points and routes stay developer-level). */
export const EDITOR_ALERTING_SUBJECTS = [
    'AlertRule',
] as const satisfies readonly CaslSubjectNames[];

interface Project {
    organizationUuid: string;
    projectUuid: string;
}

interface Organization {
    organizationUuid: string;
}

export type CaslSubjectNames =
    | 'AgentReadDiscover'
    | 'AgentQuery'
    | 'AgentRawSql'
    | 'AgentContentWrite'
    | 'AgentDelete'
    | 'AgentPublish'
    | 'AgentDeployUpload'
    | 'AgentDbtWriteback'
    | 'AgentExport'
    | 'AgentAdministration'
    | 'AgentExternalTools'
    | 'AiAgent'
    | 'AiAgentDocument'
    | 'AiAgentSkill'
    | 'AiAgentThread'
    | 'AiAgentThreadContext'
    | 'AiDeepResearch'
    | 'AlertRule'
    | 'Analytics'
    | 'SystemAnalytics'
    | 'ChangeCsvResults'
    | 'CompiledSql'
    | 'CompileProject'
    | 'ContactPoint'
    | 'ContentAsCode'
    | 'ContentVerification'
    | 'VerifiedContent'
    | 'CustomFields'
    | 'CustomSql'
    | 'CustomSqlTableCalculations'
    | 'DataApp'
    | 'DataAppDependency'
    | 'Dashboard'
    | 'Document'
    | 'DeployProject'
    | 'DashboardComments'
    | 'DeletedContent'
    | 'EmbedAiAgent'
    | 'EmbedAiAgentDebug'
    | 'EmbedCompiledSql'
    | 'EmbedDashboardFilters'
    | 'EmbedDashboardFilterAddition'
    | 'EmbedDashboardParameters'
    | 'EmbedCsvExport'
    | 'EmbedDashboardCsvExport'
    | 'EmbedImageExport'
    | 'EmbedPagePdfExport'
    | 'EmbedDateZoom'
    | 'EmbedExplore'
    | 'EmbedUnderlyingData'
    | 'EmbedDataApps'
    | 'Explore'
    | 'ExternalConnection'
    | 'ExternalSource'
    | 'ExportCsv'
    | 'GitIntegration'
    | 'GoogleSheets'
    | 'Group'
    | 'InviteLink'
    | 'Job'
    | 'JobStatus'
    | 'MetricsTree'
    | 'NotificationRoute'
    | 'Organization'
    | 'OrganizationAiAgent'
    | 'OrganizationColorPalette'
    | 'OrganizationDesign'
    | 'OrganizationMemberProfile'
    | 'OrganizationWarehouseCredentials'
    | 'PersonalAccessToken'
    | 'PreAggregation'
    | 'PinnedItems'
    | 'Project'
    | 'ProjectHomepage'
    | 'Roadmap'
    | 'Learn'
    | 'SavedChart'
    | 'ScheduledDeliveries'
    | 'SemanticViewer'
    | 'SourceCode'
    | 'Space'
    | 'SpotlightTableConfig'
    | 'SqlRunner'
    | 'Tags'
    | 'UnderlyingData'
    | 'User'
    | 'Validation'
    | 'VirtualView';

export type Subject =
    | CaslSubjectNames
    | Project
    | Organization
    | OrganizationMemberProfile
    | 'all';

export type PossibleAbilities = [
    AbilityAction,
    Subject | ForcedSubject<Exclude<Subject, 'all'>>,
];

export type MemberAbility = Ability<PossibleAbilities>;
