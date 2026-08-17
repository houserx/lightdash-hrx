import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { getPermissionsFromAbilityRules } from './abilityPermissions';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Maps organization member roles to their equivalent scopes, derived by
 * inspection of `organizationMemberAbility.ts`'s cascaded `can()` calls
 * (mirrors how `roleToScopeMapping.ts`'s `PROJECT_ROLE_TO_SCOPES_MAP` was
 * derived from `projectMemberAbility.ts`). No such mapping existed before --
 * org-context scope-based ability building previously reused the project
 * role's scope list as an approximation (see `roleToScopeParity.test.ts`'s
 * `testOrgRoleScopeParity`), which is accurate for most scopes since the two
 * hand-written files are near-mirrors, but not exact (see the `view:Job`
 * note below).
 *
 * Each role's array is a flat, explicit enumeration -- composition, not
 * inheritance -- matching `PROJECT_ROLE_TO_SCOPES_MAP`'s shape. Kept as
 * independent literal data rather than derived from the project map at
 * runtime, since the two are allowed to diverge (and already do, for
 * `view:Job`) -- deriving one from the other would silently propagate
 * future project-only changes into org context.
 *
 * Known, confirmed divergence from the project mapping: `organizationMemberAbility.ts`
 * never grants unconditional `view:Job` at any tier -- only the self-scoped
 * `view:Job@self` (`interactive_viewer`, via `can('view', 'Job', { userUuid })`)
 * and `create:Job` (unconditional). Broader Job access at `editor` and above
 * comes only from `manage:Job` (CASL's `manage` implies every action,
 * including `view`) -- so `view:Job` is intentionally omitted from every
 * tier here, unlike the project mapping which lists it explicitly at
 * `interactive_viewer` and up.
 *
 * Two more confirmed vocabulary gaps, surfaced by the (now-deleted, A10c)
 * differential harness against the hand-written builder, are still live --
 * no scope in `scopes.ts` covers either grant's exact shape, and the
 * mapping below deliberately picks the narrower available scope (safer
 * under-grant) rather than a broader one that would over-grant:
 * - `create:Project`: the hand-written admin grant was unconditional across
 *   both `DEFAULT` and `PREVIEW` types; `create:Project@preview` (used here)
 *   only ever covers `PREVIEW`.
 * - `delete:Project`: the hand-written developer grant was `{ type: PREVIEW }`
 *   with no creator restriction -- deletable by anyone, but only previews.
 *   Neither existing scope matches exactly: `delete:Project` allows any
 *   project type; `delete:Project@self` (used here) restricts to previews
 *   the caller created themselves, narrower than intended but never
 *   over-granting.
 */
export const ORGANIZATION_ROLE_TO_SCOPES_MAP: Record<
    OrganizationMemberRole,
    string[]
> = {
    [OrganizationMemberRole.MEMBER]: [
        'view:JobStatus@self',
        'view:PinnedItems',
        'view:OrganizationMemberProfile',
    ],

    [OrganizationMemberRole.VIEWER]: [
        // --- member ---
        'view:JobStatus@self',
        'view:PinnedItems',
        'view:OrganizationMemberProfile',

        // --- + viewer ---
        'view:Dashboard',
        'view:SavedChart',
        'view:Space',
        'view:OrganizationDesign',
        'view:Project',
        'view:Organization',
        'manage:ExportCsv',
        'view:DashboardComments',
        'view:Tags',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',
    ],

    [OrganizationMemberRole.INTERACTIVE_VIEWER]: [
        // --- viewer ---
        'view:JobStatus@self',
        'view:PinnedItems',
        'view:OrganizationMemberProfile',
        'view:Dashboard',
        'view:SavedChart',
        'view:Space',
        'view:OrganizationDesign',
        'view:Project',
        'view:Organization',
        'manage:ExportCsv',
        'view:DashboardComments',
        'view:Tags',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',

        // --- + interactive_viewer ---
        'create:Job',
        'view:Job@self', // No broad view:Job at this tier -- see module doc
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:ChangeCsvResults',
        'manage:Explore',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'manage:GoogleSheets',
        'create:DashboardComments',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:ContentVerification',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',
    ],

    [OrganizationMemberRole.EDITOR]: [
        // --- viewer ---
        'view:JobStatus@self',
        'view:PinnedItems',
        'view:OrganizationMemberProfile',
        'view:Dashboard',
        'view:SavedChart',
        'view:Space',
        'view:OrganizationDesign',
        'view:Project',
        'view:Organization',
        'manage:ExportCsv',
        'view:DashboardComments',
        'view:Tags',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',

        // --- interactive_viewer ---
        'create:Job',
        'view:Job@self',
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:ChangeCsvResults',
        'manage:Explore',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'manage:GoogleSheets',
        'create:DashboardComments',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:ContentVerification',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',

        // --- + editor ---
        'create:DataApp',
        'manage:Space@public',
        'create:Space',
        'manage:Job', // Implies view/create/update/delete Job -- see module doc
        'manage:PinnedItems',
        'manage:DashboardComments',
        'manage:SemanticViewer',
        'manage:Tags',
        'manage:MetricsTree',
        'view:OrganizationWarehouseCredentials',
        'view:ContentAsCode',
        'create:ContentAsCode',
    ],

    [OrganizationMemberRole.DEVELOPER]: [
        // --- viewer ---
        'view:JobStatus@self',
        'view:PinnedItems',
        'view:OrganizationMemberProfile',
        'view:Dashboard',
        'view:SavedChart',
        'view:Space',
        'view:OrganizationDesign',
        'view:Project',
        'view:Organization',
        'manage:ExportCsv',
        'view:DashboardComments',
        'view:Tags',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',

        // --- interactive_viewer ---
        'create:Job',
        'view:Job@self',
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:ChangeCsvResults',
        'manage:Explore',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'manage:GoogleSheets',
        'create:DashboardComments',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:ContentVerification',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',

        // --- editor ---
        'create:DataApp',
        'manage:Space@public',
        'create:Space',
        'manage:Job',
        'manage:PinnedItems',
        'manage:DashboardComments',
        'manage:SemanticViewer',
        'manage:Tags',
        'manage:MetricsTree',
        'view:OrganizationWarehouseCredentials',
        'view:ContentAsCode',
        'create:ContentAsCode',

        // --- + developer ---
        'manage:PreAggregation',
        'manage:VirtualView',
        'manage:CustomSql',
        'manage:CustomFields',
        'view:CompiledSql',
        'manage:CustomSqlTableCalculations',
        'manage:SqlRunner',
        'manage:Validation',
        'view:SourceCode',
        'manage:SourceCode',
        // organizationMemberAbility.ts never grants an unconditional
        // promote -- only ever via space access (editor/admin role), unlike
        // projectMemberAbility.ts. The plain (non-@space) scopes are
        // deliberately excluded here for that reason.
        'promote:SavedChart@space',
        'promote:Dashboard@space',
        'manage:CompileProject',
        'create:Project@preview',
        'update:Project',
        'manage:DeployProject@self',
        'delete:Project@self',
        'manage:SpotlightTableConfig',
        'manage:ContentAsCode',
        'manage:ContentAsCode@self',
        'view:JobStatus', // All jobs in project (org-wide here)
        'manage:AiAgent',
        'manage:OrganizationAiAgent',
        'manage:AiAgentDocument',
        'manage:AiAgentThread@self',
        'manage:ContentVerification',
        'create:AiDeepResearch',
    ],

    [OrganizationMemberRole.ADMIN]: [
        // --- viewer ---
        'view:JobStatus@self',
        'view:PinnedItems',
        'view:OrganizationMemberProfile',
        'view:Dashboard',
        'view:SavedChart',
        'view:Space',
        'view:OrganizationDesign',
        'view:Project',
        'view:Organization',
        'manage:ExportCsv',
        'view:DashboardComments',
        'view:Tags',
        'view:MetricsTree',
        'view:SpotlightTableConfig',
        'view:AiAgentThread@self',

        // --- interactive_viewer ---
        'create:Job',
        'view:Job@self',
        'view:UnderlyingData',
        'view:SemanticViewer',
        'manage:ChangeCsvResults',
        'manage:Explore',
        'create:ScheduledDeliveries',
        'manage:ScheduledDeliveries@self',
        'manage:GoogleSheets',
        'create:DashboardComments',
        'manage:Dashboard@space',
        'manage:SavedChart@space',
        'manage:SemanticViewer@space',
        'manage:DataApp@space',
        'manage:Space@assigned',
        'view:AiAgent',
        'view:OrganizationAiAgent',
        'view:AiAgentDocument',
        'create:AiAgentThread',
        'view:ContentVerification',
        'view:DataApp',
        'view:DataApp@self',
        'manage:DataApp@self',
        'view:ExternalConnection',

        // --- editor ---
        'create:DataApp',
        'manage:Space@public',
        'create:Space',
        'manage:Job',
        'manage:PinnedItems',
        'manage:DashboardComments',
        'manage:SemanticViewer',
        'manage:Tags',
        'manage:MetricsTree',
        'view:OrganizationWarehouseCredentials',
        'view:ContentAsCode',
        'create:ContentAsCode',

        // --- developer ---
        'manage:PreAggregation',
        'manage:VirtualView',
        'manage:CustomSql',
        'manage:CustomFields',
        'view:CompiledSql',
        'manage:CustomSqlTableCalculations',
        'manage:SqlRunner',
        'manage:Validation',
        'view:SourceCode',
        'manage:SourceCode',
        // organizationMemberAbility.ts never grants an unconditional
        // promote -- only ever via space access (editor/admin role), unlike
        // projectMemberAbility.ts. The plain (non-@space) scopes are
        // deliberately excluded here for that reason.
        'promote:SavedChart@space',
        'promote:Dashboard@space',
        'manage:CompileProject',
        'create:Project@preview',
        'update:Project',
        'manage:DeployProject@self',
        'delete:Project@self',
        'manage:SpotlightTableConfig',
        'manage:ContentAsCode',
        'manage:ContentAsCode@self',
        'view:JobStatus',
        'manage:AiAgent',
        'manage:OrganizationAiAgent',
        'manage:AiAgentDocument',
        'manage:AiAgentThread@self',
        'manage:ContentVerification',
        'create:AiDeepResearch',

        // --- + admin ---
        'view:Roadmap',
        'manage:DataApp',
        'manage:DataAppDependency',
        'manage:ExternalConnection',
        'manage:OrganizationDesign',
        'manage:Dashboard',
        'manage:Space',
        'manage:SavedChart',
        // KNOWN GAP: admin's real grant is `create:Project` for BOTH
        // ProjectType.DEFAULT and PREVIEW, unconditional. No scope in the
        // vocabulary covers DEFAULT-type project creation at all --
        // `create:Project@preview` (already included via the developer
        // block above) only ever covers PREVIEW. Left unmapped rather than
        // guessed at; expect the differential test to flag this.
        'delete:Project',
        'manage:Project',
        'manage:InviteLink',
        'manage:Organization',
        'manage:OrganizationColorPalette',
        'view:Analytics',
        'manage:OrganizationMemberProfile',
        'manage:ProjectHomepage',
        'manage:Group',
        'manage:OrganizationWarehouseCredentials',
        'view:AiAgentThread',
        'manage:AiAgentThread',
        'manage:ScheduledDeliveries',
        'manage:DeletedContent',
        'manage:GitIntegration',
        'manage:DeployProject',
        'impersonate:User',
    ],
};

/**
 * Gets the scopes required for a specific organization member role. Mirrors
 * `roleToScopeMapping.ts`'s `getAllScopesForRole` -- a defensive copy so
 * callers can't mutate the shared literal array.
 */
export const getAllScopesForOrgRole = (
    role: OrganizationMemberRole,
): string[] => [...ORGANIZATION_ROLE_TO_SCOPES_MAP[role]];

/**
 * Canonical action/subject footprint emitted by a system organization role.
 * Feeds `organizationRolePermissions.ts`'s confused-deputy grant check
 * (`validateOrganizationScopesCanBeGranted`) -- isEnterprise: true because
 * this must be conservative: under-reporting a role's permissions here
 * would weaken that check, and the hand-written builder this replaced
 * (A10c) never filtered by license either. Verified byte-identical to the
 * pre-A10c hand-written output for every role by
 * `getOrganizationMemberRolePermissions.goldenMaster.test.ts`.
 */
export const getOrganizationMemberRolePermissions = (
    role: OrganizationMemberRole,
): string[] => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    buildAbilityFromScopes(
        {
            organizationUuid: 'delegation-validation-organization',
            userUuid: 'delegation-validation-user',
            scopes: getAllScopesForOrgRole(role),
            isEnterprise: true,
        },
        builder,
    );

    return getPermissionsFromAbilityRules(builder.rules);
};
