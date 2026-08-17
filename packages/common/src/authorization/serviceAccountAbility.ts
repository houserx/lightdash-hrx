import { Ability, AbilityBuilder } from '@casl/ability';
import { ServiceAccountScope } from '../ee/serviceAccounts/types';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { ProjectType } from '../types/projects';
import { getPermissionsFromAbilityRules } from './abilityPermissions';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

type ServiceAccountAbilitiesArgs = {
    organizationUuid: string;
    // Full builder (not just `can`) -- the SYSTEM_* handlers' scope-composed
    // path reads `builder.rules` via `buildAbilityFromScopes`'s PAT-gate
    // dedup check. Every real caller already constructs a full
    // `AbilityBuilder`.
    builder: AbilityBuilder<MemberAbility>;
    // Dedicated user uuid for the service account. Required so that
    // `*@self`-style ability conditions (e.g. `manage:DeployProject@self`,
    // `delete:Project@self`) resolve to the SA's own row rather than
    // matching nothing. Older legacy-scope handlers that don't reference
    // userUuid keep working unchanged.
    userUuid: string;
};

const applySystemRoleAlias = (
    role: OrganizationMemberRole,
    { organizationUuid, userUuid, builder }: ServiceAccountAbilitiesArgs,
): void => {
    buildAbilityFromScopes(
        {
            organizationUuid,
            userUuid,
            scopes: getAllScopesForOrgRole(role),
            isEnterprise: true,
        },
        builder,
    );
};

const applyServiceAccountStaticAbilities: Record<
    ServiceAccountScope,
    (args: ServiceAccountAbilitiesArgs) => void
> = {
    [ServiceAccountScope.ORG_READ]: ({
        organizationUuid,
        builder: { can },
    }) => {
        can('view', 'OrganizationMemberProfile', {
            organizationUuid,
        });
        can('view', 'JobStatus');
        can('view', 'PinnedItems', {
            organizationUuid,
        });

        can('view', 'Dashboard', {
            organizationUuid,
            inheritsFromOrgOrProject: true,
        });
        can('view', 'SavedChart', {
            organizationUuid,
            inheritsFromOrgOrProject: true,
        });
        can('view', 'Dashboard', {
            organizationUuid,
        });
        can('view', 'SavedChart', {
            organizationUuid,
        });
        can('view', 'Space', {
            organizationUuid,
            inheritsFromOrgOrProject: true,
        });
        can('view', 'Space', {
            organizationUuid,
        });
        can('view', 'Project', {
            organizationUuid,
        });
        can('view', 'Organization', {
            organizationUuid,
        });
        can('manage', 'ExportCsv', {
            organizationUuid,
        });
        can('view', 'DashboardComments', {
            organizationUuid,
        });
        can('view', 'Tags', {
            organizationUuid,
        });
        can('view', 'MetricsTree', {
            organizationUuid,
        });
        can('view', 'SpotlightTableConfig', {
            organizationUuid,
        });
        can('view', 'AiAgentThread', {
            organizationUuid,
        });

        can('create', 'Job');
        can('view', 'Job');
        can('view', 'UnderlyingData', {
            organizationUuid,
        });
        can('view', 'SemanticViewer', {
            organizationUuid,
        });
        can('manage', 'ChangeCsvResults', {
            organizationUuid,
        });
        can('manage', 'Explore', {
            organizationUuid,
        });
        can('create', 'ScheduledDeliveries', {
            organizationUuid,
        });
        can('create', 'DashboardComments', {
            organizationUuid,
        });
        can('manage', 'Dashboard', {
            organizationUuid,
        });
        can('manage', 'SavedChart', {
            organizationUuid,
        });

        can('manage', 'SemanticViewer', {
            organizationUuid,
        });
        can('manage', 'Dashboard', {
            organizationUuid,
        });
        can('manage', 'SavedChart', {
            organizationUuid,
        });

        can('manage', 'Space', {
            organizationUuid,
        });

        can('view', 'AiAgent', {
            organizationUuid,
        });
        can('view', 'OrganizationAiAgent', {
            organizationUuid,
        });
        can('view', 'AiAgentDocument', {
            organizationUuid,
        });
        can('create', 'AiAgentThread', {
            organizationUuid,
        });
        can('view', 'OrganizationDesign', {
            organizationUuid,
        });
        can('view', 'ContentVerification', {
            organizationUuid,
        });
    },
    [ServiceAccountScope.ORG_EDIT]: ({
        organizationUuid,
        userUuid,
        builder,
    }) => {
        const { can } = builder;
        applyServiceAccountStaticAbilities[ServiceAccountScope.ORG_READ]({
            organizationUuid,
            userUuid,
            builder,
        });
        can('manage', 'Space', {
            organizationUuid,
            inheritsFromOrgOrProject: true,
        });
        can('create', 'Space', {
            organizationUuid,
        });
        can('manage', 'Job');
        can('manage', 'PinnedItems', {
            organizationUuid,
        });
        can('manage', 'ScheduledDeliveries', {
            organizationUuid,
        });
        can('manage', 'DashboardComments', {
            organizationUuid,
        });
        can('manage', 'SemanticViewer', {
            organizationUuid,
        });
        can('manage', 'Tags', {
            organizationUuid,
        });
        can('manage', 'MetricsTree', {
            organizationUuid,
        });
        // CLI-driven content-as-code upload (`lightdash upload`) runs as an
        // SA with `org:edit`. Pre-Phase-C the auth middleware spoofed the
        // admin user so the call was implicitly allowed; the cutover to a
        // dedicated SA identity dropped that side-effect, so we restore it
        // here explicitly to preserve the existing CI workflow.
        can('manage', 'ContentAsCode', {
            organizationUuid,
        });
    },
    [ServiceAccountScope.ORG_ADMIN]: ({
        organizationUuid,
        userUuid,
        builder,
    }) => {
        const { can } = builder;
        applyServiceAccountStaticAbilities[ServiceAccountScope.ORG_EDIT]({
            organizationUuid,
            userUuid,
            builder,
        });
        can('view', 'Roadmap', {
            organizationUuid,
        });
        can('manage', 'PreAggregation', {
            organizationUuid,
        });
        can('manage', 'VirtualView', {
            organizationUuid,
        });
        can('manage', 'CustomSql', {
            organizationUuid,
        });
        can('manage', 'CustomFields', {
            organizationUuid,
        });
        can('view', 'CompiledSql', {
            organizationUuid,
        });
        can('manage', 'CustomSqlTableCalculations', {
            organizationUuid,
        });
        can('manage', 'SqlRunner', {
            organizationUuid,
        });
        can('manage', 'Validation', {
            organizationUuid,
        });
        can('promote', 'SavedChart', {
            organizationUuid,
        });
        can('promote', 'Dashboard', {
            organizationUuid,
        });
        can('manage', 'CompileProject', {
            organizationUuid,
        });
        can('create', 'Project', {
            organizationUuid,
            type: ProjectType.PREVIEW,
        });
        can('manage', 'DeployProject', {
            organizationUuid,
        });
        can('update', 'Project', {
            organizationUuid,
        });
        can('delete', 'Project', {
            organizationUuid,
            type: ProjectType.PREVIEW,
        });
        can('manage', 'SpotlightTableConfig', {
            organizationUuid,
        });
        can('manage', 'ContentAsCode', {
            organizationUuid,
        });
        can('manage', 'ContentVerification', {
            organizationUuid,
        });
        can('view', 'JobStatus', {
            organizationUuid,
        });
        can('manage', 'AiAgent', {
            organizationUuid,
        });
        can('manage', 'OrganizationAiAgent', {
            organizationUuid,
        });
        can('manage', 'AiAgentDocument', {
            organizationUuid,
        });
        can('manage', 'AiAgentThread', {
            organizationUuid,
        });
        can('manage', 'DataApp', {
            organizationUuid,
        });
        can('manage', 'DataAppDependency', {
            organizationUuid,
        });
        can('manage', 'ExternalConnection', {
            organizationUuid,
        });
        can('manage', 'OrganizationDesign', {
            organizationUuid,
        });
        can('manage', 'Dashboard', {
            organizationUuid,
        });
        can('manage', 'Space', {
            organizationUuid,
        });
        can('manage', 'SavedChart', {
            organizationUuid,
        });
        can('create', 'Project', {
            organizationUuid,
            type: { $in: [ProjectType.DEFAULT, ProjectType.PREVIEW] },
        });
        can('delete', 'Project', {
            organizationUuid,
        });
        can('manage', 'Project', {
            organizationUuid,
        });
        can('manage', 'InviteLink', {
            organizationUuid,
        });
        can('manage', 'Organization', {
            organizationUuid,
        });
        can('manage', 'OrganizationColorPalette', {
            organizationUuid,
        });
        can('view', 'Analytics', {
            organizationUuid,
        });
        can('manage', 'OrganizationMemberProfile', {
            organizationUuid,
        });
        can('manage', 'PinnedItems', {
            organizationUuid,
        });
        can('manage', 'ProjectHomepage', {
            organizationUuid,
        });
        can('manage', 'Group', {
            organizationUuid,
        });
        can('view', 'AiAgentThread', {
            organizationUuid,
        });
        can('manage', 'AiAgentThread', {
            organizationUuid,
        });
    },
    [ServiceAccountScope.SCIM_MANAGE]: ({
        organizationUuid,
        builder: { can },
    }) => {
        can('manage', 'OrganizationMemberProfile', {
            organizationUuid,
        });
        can('manage', 'Group', {
            organizationUuid,
        });
    },
    // System-role aliases. Each one grants exactly the same CASL as a human
    // org member with that role -- either via the same flag-gated
    // scope-composed path humans use (A6), or (when the flag is off) by
    // delegating to the matching hand-written org-member ability builder.
    // No parallel scope mapping to drift out of sync either way.
    [ServiceAccountScope.SYSTEM_MEMBER]: (args) =>
        applySystemRoleAlias(OrganizationMemberRole.MEMBER, args),
    [ServiceAccountScope.SYSTEM_ADMIN]: (args) =>
        applySystemRoleAlias(OrganizationMemberRole.ADMIN, args),
    [ServiceAccountScope.SYSTEM_DEVELOPER]: (args) =>
        applySystemRoleAlias(OrganizationMemberRole.DEVELOPER, args),
    [ServiceAccountScope.SYSTEM_EDITOR]: (args) =>
        applySystemRoleAlias(OrganizationMemberRole.EDITOR, args),
    [ServiceAccountScope.SYSTEM_INTERACTIVE_VIEWER]: (args) =>
        applySystemRoleAlias(OrganizationMemberRole.INTERACTIVE_VIEWER, args),
    [ServiceAccountScope.SYSTEM_VIEWER]: (args) =>
        applySystemRoleAlias(OrganizationMemberRole.VIEWER, args),
};

/**
 * Returns the canonical action/subject footprint emitted by a legacy service
 * account scope. Deriving this from the ability builder keeps delegation
 * validation in lockstep with the permissions the token actually receives.
 * Conditions are intentionally omitted: the resulting unmodified permission
 * is conservative when compared with a caller's custom-role scopes.
 */
export const getServiceAccountScopePermissions = (
    scope: ServiceAccountScope,
): string[] => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    applyServiceAccountStaticAbilities[scope]({
        organizationUuid: 'delegation-validation-organization',
        userUuid: 'delegation-validation-user',
        builder,
    });

    return getPermissionsFromAbilityRules(builder.rules);
};

export const applyServiceAccountAbilities = ({
    organizationUuid,
    userUuid,
    builder,
    scopes,
}: ServiceAccountAbilitiesArgs & {
    scopes: ServiceAccountScope[];
}) => {
    scopes.forEach((scope) => {
        applyServiceAccountStaticAbilities[scope]({
            organizationUuid,
            userUuid,
            builder,
        });
    });
};
