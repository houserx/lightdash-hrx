import {
    ProjectMemberRole,
    ProjectMemberRoleLabels,
} from '../types/projectMemberRole';
import type { RoleWithScopes } from '../types/roles';

/**
 * Maps project member roles to their equivalent scopes, based on
 * `projectMemberAbility.ts` analysis. Each role's array is a flat, explicit
 * enumeration of every scope it carries -- not derived by unioning a lower
 * tier's list at runtime. A higher role's array already includes everything
 * the tiers below it grant, stated outright (composition), rather than
 * being computed by a role calling into the tier below it (inheritance).
 * Comments mark which tier first introduces each contiguous block, purely
 * for readability -- they carry no runtime meaning.
 */
export const PROJECT_ROLE_TO_SCOPES_MAP: Record<ProjectMemberRole, string[]> = {
    [ProjectMemberRole.VIEWER]: [
        // --- viewer ---
        // Basic viewing permissions
        'view:Dashboard',
        'view:JobStatus@self', // For viewing job status created by user
        'view:SavedChart',
        'view:Space',
        'view:Project',
        'view:PinnedItems',
        'view:DashboardComments',
        'view:Tags',
        'manage:ExportCsv',

        // Org-context view scopes — every member-or-above can see the
        // org's own metadata + the list of fellow members. Granted by
        // `applyOrganizationMemberStaticAbilities.member` / `viewer`.
        'view:Organization',
        'view:OrganizationMemberProfile',

        // Enterprise scopes (when available)
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',
        'view:OrganizationDesign',
    ],

    [ProjectMemberRole.INTERACTIVE_VIEWER]: [
        // --- viewer ---
        'view:Dashboard',
        'view:JobStatus@self',
        'view:SavedChart',
        'view:Space',
        'view:Project',
        'view:PinnedItems',
        'view:DashboardComments',
        'view:Tags',
        'manage:ExportCsv',
        'view:Organization',
        'view:OrganizationMemberProfile',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',
        'view:OrganizationDesign',

        // --- + interactive_viewer ---
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:Explore',
        'manage:ChangeCsvResults',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'create:DashboardComments',
        'manage:GoogleSheets',

        // Job tracking — orchestrating queries/exports/etc. Granted at
        // `applyOrganizationMemberStaticAbilities.interactive_viewer`.
        'create:Job',
        'view:Job',
        'view:Job@self',

        // Space-level content management (requires space admin/editor role)
        'manage:Dashboard@space', // Via space access
        'manage:SavedChart@space', // Via space access
        'manage:SemanticViewer@space', // Via space access (paired w/ @space content)
        'manage:DataApp@space', // Via space access
        'manage:Space@assigned', // Via space access (admin role)

        // Enterprise scopes
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:DataApp', // Project-wide + space-access view (parity with manage:Explore)
        'view:DataApp@self', // Own personal apps (created before demotion / under older rules)
        'manage:DataApp@self', // Own personal apps (created before demotion / under older rules)
        'view:ExternalConnection', // Link admin-enabled connections when editing space apps
        'view:ContentVerification', // Read-only discovery of verified content (manage stays developer-level)
    ],

    [ProjectMemberRole.EDITOR]: [
        // --- viewer ---
        'view:Dashboard',
        'view:JobStatus@self',
        'view:SavedChart',
        'view:Space',
        'view:Project',
        'view:PinnedItems',
        'view:DashboardComments',
        'view:Tags',
        'manage:ExportCsv',
        'view:Organization',
        'view:OrganizationMemberProfile',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',
        'view:OrganizationDesign',

        // --- interactive_viewer ---
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:Explore',
        'manage:ChangeCsvResults',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'create:DashboardComments',
        'manage:GoogleSheets',
        'create:Job',
        'view:Job',
        'view:Job@self',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',
        'view:ContentVerification',

        // --- + editor ---
        'create:Space',
        'manage:Space@public', // For non-private spaces
        'manage:Job',
        'manage:PinnedItems',
        'manage:DashboardComments',
        'manage:Tags',

        // Broad SemanticViewer mgmt — promoted from the @space variant
        // when the user reaches editor tier. Granted at
        // `applyOrganizationMemberStaticAbilities.editor`.
        'manage:SemanticViewer',

        // View-only access to org warehouse creds — needed before admin
        // tier so editors can see what's already configured. Granted at
        // `applyOrganizationMemberStaticAbilities.editor`.
        'view:OrganizationWarehouseCredentials',

        // Enterprise scopes
        'manage:MetricsTree',
        'manage:AiAgentThread@self', // User's own threads
        'view:ContentAsCode',
        'create:ContentAsCode',
        'create:DataApp',
    ],

    [ProjectMemberRole.DEVELOPER]: [
        // --- viewer ---
        'view:Dashboard',
        'view:JobStatus@self',
        'view:SavedChart',
        'view:Space',
        'view:Project',
        'view:PinnedItems',
        'view:DashboardComments',
        'view:Tags',
        'manage:ExportCsv',
        'view:Organization',
        'view:OrganizationMemberProfile',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',
        'view:OrganizationDesign',

        // --- interactive_viewer ---
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:Explore',
        'manage:ChangeCsvResults',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'create:DashboardComments',
        'manage:GoogleSheets',
        'create:Job',
        'view:Job',
        'view:Job@self',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',
        'view:ContentVerification',

        // --- editor ---
        'create:Space',
        'manage:Space@public',
        'manage:Job',
        'manage:PinnedItems',
        'manage:DashboardComments',
        'manage:Tags',
        'manage:SemanticViewer',
        'view:OrganizationWarehouseCredentials',
        'manage:MetricsTree',
        'manage:AiAgentThread@self',
        'view:ContentAsCode',
        'create:ContentAsCode',
        'create:DataApp',

        // --- + developer ---
        'manage:PreAggregation',
        'manage:VirtualView',
        // Granular create/delete companions to manage:VirtualView. Both
        // covered by the broader manage at runtime, but listed
        // explicitly so the role-builder UI shows them ticked.
        'create:VirtualView',
        'delete:VirtualView',
        'manage:CustomSql',
        'manage:CustomFields',
        'view:CompiledSql',
        'manage:CustomSqlTableCalculations',
        'manage:SqlRunner',
        'manage:Validation',
        'manage:CompileProject',
        'manage:DeployProject',
        'manage:DeployProject@self',
        'create:Project@preview', // Preview projects
        'delete:Project@self', // Preview projects created by user
        'update:Project',
        'update:Project@self',
        // Redundant for developers (covered by broader content manage
        // scopes) but surfaced so cloned custom roles can drop production
        // edit rights and keep editing inside previews the user created.
        'manage:Dashboard@self',
        'manage:SavedChart@self',
        'manage:Space@self',
        'manage:Explore@self',
        'view:JobStatus', // All jobs in project
        'view:SourceCode',
        'manage:SourceCode',

        // Promote to upstream project. Both broad + @space variants
        // surface in `applyOrganizationMemberStaticAbilities.developer`.
        'promote:Dashboard',
        'promote:Dashboard@space',
        'promote:SavedChart',
        'promote:SavedChart@space',

        // Enterprise scopes
        'manage:SpotlightTableConfig',
        'manage:ContentAsCode',
        // Redundant for developers (covered by the broad manage above) but
        // surfaced so admin-cloned custom roles can drop full
        // `manage:ContentAsCode` and keep self-preview write.
        'manage:ContentAsCode@self',
        'manage:AiAgent',
        'manage:OrganizationAiAgent',
        'manage:AiAgentDocument',
        'manage:ContentVerification',
        'create:AiDeepResearch',
    ],

    [ProjectMemberRole.ADMIN]: [
        // --- viewer ---
        'view:Dashboard',
        'view:JobStatus@self',
        'view:SavedChart',
        'view:Space',
        'view:Project',
        'view:PinnedItems',
        'view:DashboardComments',
        'view:Tags',
        'manage:ExportCsv',
        'view:Organization',
        'view:OrganizationMemberProfile',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',
        'view:OrganizationDesign',

        // --- interactive_viewer ---
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:Explore',
        'manage:ChangeCsvResults',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'create:DashboardComments',
        'manage:GoogleSheets',
        'create:Job',
        'view:Job',
        'view:Job@self',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',
        'view:ContentVerification',

        // --- editor ---
        'create:Space',
        'manage:Space@public',
        'manage:Job',
        'manage:PinnedItems',
        'manage:DashboardComments',
        'manage:Tags',
        'manage:SemanticViewer',
        'view:OrganizationWarehouseCredentials',
        'manage:MetricsTree',
        'manage:AiAgentThread@self',
        'view:ContentAsCode',
        'create:ContentAsCode',
        'create:DataApp',

        // --- developer ---
        'manage:PreAggregation',
        'manage:VirtualView',
        'create:VirtualView',
        'delete:VirtualView',
        'manage:CustomSql',
        'manage:CustomFields',
        'view:CompiledSql',
        'manage:CustomSqlTableCalculations',
        'manage:SqlRunner',
        'manage:Validation',
        'manage:CompileProject',
        'manage:DeployProject',
        'manage:DeployProject@self',
        'create:Project@preview',
        'delete:Project@self',
        'update:Project',
        'update:Project@self',
        'manage:Dashboard@self',
        'manage:SavedChart@self',
        'manage:Space@self',
        'manage:Explore@self',
        'view:JobStatus',
        'view:SourceCode',
        'manage:SourceCode',
        'promote:Dashboard',
        'promote:Dashboard@space',
        'promote:SavedChart',
        'promote:SavedChart@space',
        'manage:SpotlightTableConfig',
        'manage:ContentAsCode',
        'manage:ContentAsCode@self',
        'manage:AiAgent',
        'manage:OrganizationAiAgent',
        'manage:AiAgentDocument',
        'manage:ContentVerification',
        'create:AiDeepResearch',

        // --- + admin ---
        'manage:DataApp',
        'manage:DataAppDependency', // Add custom npm deps (supply-chain capability)
        'manage:ExternalConnection',
        'manage:OrganizationDesign',
        'delete:Project', // Any project
        'view:Analytics',
        'manage:Dashboard', // All dashboards
        'manage:Space', // All spaces
        'manage:Project', // Required for managing non-private spaces
        'manage:SavedChart', // All saved charts
        'manage:DeletedContent', // Soft-deleted content management
        'manage:ProjectHomepage', // Curated project homepages (EE)
        'view:AiAgentThread', // All threads in project
        'manage:AiAgentThread', // All threads in project
        'manage:ScheduledDeliveries',

        // Organization-management scopes. These are no-ops at project
        // assignment (CASL conditions match `organizationUuid`-keyed
        // subjects only) but are necessary at the role's intended ORG
        // assignment — service accounts with `roleUuid`, or any future
        // org-level human assignment. See `docs/authentication-and-roles.md`
        // → "Project vs organization assignment of custom roles".
        // Granted at `applyOrganizationMemberStaticAbilities.admin`.
        'manage:OrganizationMemberProfile',
        'manage:Group',
        'manage:InviteLink',
        'manage:GitIntegration',
        'manage:OrganizationWarehouseCredentials',
        'manage:Organization',
        'manage:OrganizationColorPalette',
        'view:Roadmap',
        'impersonate:User',

        // PAT management. Granted dynamically at runtime via
        // `applyOrganizationMemberDynamicAbilities` based on the
        // deployment-wide `PAT_ALLOWED_ORG_ROLES` env var — that path
        // remains the source of truth for system roles. Listing it
        // here lets admin-clone custom roles surface the toggle in the
        // role builder. **Caveat:** toggling it in a custom role
        // *bypasses* the dynamic gate, since CASL is additive (the
        // static scope-built rule wins regardless of deployment
        // config). Operators who clone admin into a lower-privilege
        // role should untick it manually if their deployment intends
        // to restrict PAT to specific tiers.
        'manage:PersonalAccessToken',
    ],
};

/**
 * Ordered list of all built-in project system roles, lowest to highest.
 * Used only for enumeration (`getSystemRoleNames`, `isSystemRoleName`) -- no
 * scope-union computation is derived from this ordering anymore.
 */
const ROLE_HIERARCHY = [
    ProjectMemberRole.VIEWER,
    ProjectMemberRole.INTERACTIVE_VIEWER,
    ProjectMemberRole.EDITOR,
    ProjectMemberRole.DEVELOPER,
    ProjectMemberRole.ADMIN,
] as const;

/**
 * Gets the scopes required for a specific project member role
 */
export const getAllScopesForRole = (role: ProjectMemberRole): string[] => [
    ...PROJECT_ROLE_TO_SCOPES_MAP[role],
];

/**
 * Gets only the non-enterprise scopes for a role (filters out enterprise-only features)
 */
export const getNonEnterpriseScopesForRole = (
    role: ProjectMemberRole,
): string[] => {
    const enterpriseScopes = new Set([
        'view:MetricsTree',
        'manage:MetricsTree',
        'view:SpotlightTableConfig',
        'manage:SpotlightTableConfig',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'view:AiAgentThread',
        'create:AiAgentThread',
        'manage:AiAgent',
        'manage:OrganizationAiAgent',
        'manage:AiAgentDocument',
        'manage:AiAgentThread',
        'view:ContentAsCode',
        'create:ContentAsCode',
        'manage:ContentAsCode',
        'manage:ContentAsCode@self',
        'view:DataApp',
        'manage:DataApp',
        'manage:DataApp@space',
        'create:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',
        'manage:ExternalConnection',
        'view:OrganizationDesign',
        'manage:OrganizationDesign',
        'view:Roadmap',
        'manage:PersonalAccessToken',
        'manage:PreAggregation',
    ]);

    return PROJECT_ROLE_TO_SCOPES_MAP[role].filter(
        (scope) => !enterpriseScopes.has(scope),
    );
};

/**
 * Lists project system roles for role-assignment CRUD/display purposes,
 * with `roleUuid` set to the role-name string itself (e.g. "viewer") --
 * a display/API identity, NOT the real well-known role_uuid seeded into
 * `roles`/`scoped_roles` by migration (see systemRoleUuids.ts). Ability-
 * building never reads this; it's a permanently separate concern from
 * scope resolution. Renamed from `getSystemRoles`/`isSystemRole`
 * specifically to remove the false kinship the old names implied with
 * systemRoleUuids.ts's real UUIDs -- the two schemes stay unified in name
 * only by accident of history, not by any shared underlying identifier.
 * Do not change the string this returns for `roleUuid`: it's serialized
 * as-is into the `GET /orgs/{orgUuid}/roles` API response and into SCIM
 * role ids that external identity providers (Okta, Entra) persist.
 */
export const getSystemRoleNames = (): RoleWithScopes[] =>
    ROLE_HIERARCHY.map((role) => ({
        roleUuid: role,
        name: ProjectMemberRoleLabels[role],
        description: ProjectMemberRoleLabels[role],
        ownerType: 'system',
        level: 'project',
        scopes: getAllScopesForRole(role),
        organizationUuid: null,
        createdAt: null,
        updatedAt: null,
        createdBy: null,
    }));

export const isSystemRoleName = (
    roleUuid: string,
): roleUuid is ProjectMemberRole =>
    ROLE_HIERARCHY.includes(roleUuid as ProjectMemberRole);
