import {
    type ResourceAccessAction,
    type ResourceAccessList,
    type ResourceShare,
} from '@lightdash/common';

/**
 * One rank per action, so adding an action to the vocabulary without deciding
 * where it revokes is a compile error rather than a silently mis-ordered -- or
 * skipped -- DELETE.
 *
 * Most permissive first: a revoke issues one request per action, so a run that
 * fails partway has then already reduced access rather than left it untouched.
 */
const REVOKE_RANK: Record<ResourceAccessAction, number> = {
    manage: 0,
    view: 1,
};

export const REVOKE_ACTION_ORDER: readonly ResourceAccessAction[] = (
    Object.keys(REVOKE_RANK) as ResourceAccessAction[]
).sort((left, right) => REVOKE_RANK[left] - REVOKE_RANK[right]);

/**
 * Whether this surface can revoke a principal's grant, and what revoking means.
 *
 * `no_user_grant` is the honest name: it says only that no grant is recorded
 * against this user, which is all the payload can support. Their access may
 * still come from a grant made to a group they belong to -- the resolver expands
 * those per member, but the grant list records them against the group, and
 * group membership is not in either response. Calling that state "group grant"
 * would assert provenance from an absence.
 */
export type ResourceGrantState =
    | { kind: 'user_grant'; actions: ResourceAccessAction[] }
    | { kind: 'no_user_grant' };

export type ResourceAccessRow = {
    share: ResourceShare;
    grant: ResourceGrantState;
};

export type ResourceGroupGrant = {
    groupUuid: string;
    actions: ResourceAccessAction[];
};

const ordered = (held: Set<ResourceAccessAction>): ResourceAccessAction[] =>
    [...held].sort((left, right) => REVOKE_RANK[left] - REVOKE_RANK[right]);

/** Users and groups are keyed differently but folded identically. */
type PrincipalGrant = {
    principalUuid: string;
    action: ResourceAccessAction;
};

const actionsByPrincipal = (
    grants: PrincipalGrant[],
): Map<string, Set<ResourceAccessAction>> => {
    const held = new Map<string, Set<ResourceAccessAction>>();

    grants.forEach(({ principalUuid, action }) => {
        const actions =
            held.get(principalUuid) ?? new Set<ResourceAccessAction>();
        actions.add(action);
        held.set(principalUuid, actions);
    });

    return held;
};

/**
 * Pairs each resolved access entry with the grant, if any, that this surface can
 * revoke for it.
 *
 * The join is on the grant list and nothing else. `resolveResourceAccess` sets
 * `hasDirectAccess: true` on a merged entry even when the grant did not decide
 * the role, and leaves `inheritedFrom` naming the space origin in that case, so
 * a resolved entry cannot distinguish an inert resource grant from a direct
 * share on the surrounding space. Reading either field here would offer a
 * revoke that deletes nothing, or withhold one that was needed.
 *
 * Grants for users outside `shares` are ignored rather than appended: this is
 * one page of a paginated list, and inventing a row would show that principal
 * twice.
 */
export const toResourceAccessRows = (
    shares: ResourceShare[],
    grants: ResourceAccessList,
): ResourceAccessRow[] => {
    const held = actionsByPrincipal(
        grants.users.map(({ userUuid, action }) => ({
            principalUuid: userUuid,
            action,
        })),
    );

    return shares.map((share) => {
        const actions = held.get(share.userUuid);

        return {
            share,
            grant: actions
                ? { kind: 'user_grant', actions: ordered(actions) }
                : { kind: 'no_user_grant' },
        };
    });
};

/**
 * The group grants on this resource, one row per group. Unlike the per-user
 * join this is authoritative -- the list names the groups directly -- which is
 * what makes group-granted access removable at all.
 */
export const toGroupGrants = (
    grants: ResourceAccessList,
): ResourceGroupGrant[] =>
    [
        ...actionsByPrincipal(
            grants.groups.map(({ groupUuid, action }) => ({
                principalUuid: groupUuid,
                action,
            })),
        ).entries(),
    ]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([groupUuid, actions]) => ({
            groupUuid,
            actions: ordered(actions),
        }));
