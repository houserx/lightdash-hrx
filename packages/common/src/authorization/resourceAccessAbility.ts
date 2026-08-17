import { type AbilityBuilder } from '@casl/ability';
import { type MemberAbility } from './types';

export type ResourceAccessResourceType = 'Dashboard' | 'SavedChart';
export type ResourceAccessAction = 'view' | 'manage';

export type ResourceAccessGrant = {
    resourceUuid: string;
    resourceType: ResourceAccessResourceType;
    action: ResourceAccessAction;
};

/**
 * The `metadata.<key>` field each resource type's real permission-check
 * call site uses -- verified per-subject against DashboardService.ts's
 * `view` check (`metadata: { dashboardUuid, dashboardName }`) and
 * SavedChartService.ts's `update` check (`metadata: { savedChartUuid,
 * savedChartName }`). Not uniform: do not assume a shared key name when
 * widening to a new resource_type.
 */
export const RESOURCE_ACCESS_METADATA_KEY: Record<
    ResourceAccessResourceType,
    string
> = {
    Dashboard: 'dashboardUuid',
    SavedChart: 'savedChartUuid',
};

/**
 * Appends one CASL rule per direct resource-access grant, each keyed
 * on `metadata.<key>` the same way `jwtAbility.ts`'s
 * embed-token dashboard grants are. Purely additive: composes via CASL's
 * native OR-semantics with whatever org/project/space-derived rules
 * already exist on the builder, so a zero-row grant list is a no-op and
 * this never needs to run before/instead of those rules -- only after.
 *
 * `collapseAbilityRules` needs no change to merge multiple grants of the
 * same (action, resourceType) into one `{ 'metadata.<key>': { $in: [...] } }`
 * rule -- it already treats every scalar-string-valued top-level
 * condition key uniformly, dotted or not (see its test file's
 * "direct resource-access grants" fixture).
 */
export const applyResourceAccessAbilities = (
    grants: ResourceAccessGrant[],
    builder: AbilityBuilder<MemberAbility>,
): void => {
    grants.forEach((grant) => {
        builder.can(grant.action, grant.resourceType, {
            [`metadata.${RESOURCE_ACCESS_METADATA_KEY[grant.resourceType]}`]:
                grant.resourceUuid,
        });
    });
};
