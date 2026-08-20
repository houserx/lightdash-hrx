import {
    assertUnreachable,
    SpaceMemberRole,
    type ResourceAccessAction,
    type ResourceAccessList,
    type ResourceAccessResourceType,
    type ResourceShare,
} from '@lightdash/common';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useMemo, type FC } from 'react';
import {
    AccessOriginBadge,
    AccessPanel,
    PrincipalAccessRow,
} from '../AccessPanel/AccessPanel';
import Callout from '../Callout';
import { getAccessColor } from '../ShareSpaceModal/ShareSpaceModalUtils';
import { UserAccessOptions } from '../ShareSpaceModal/ShareSpaceSelect';
import { toUserPrincipal } from '../ShareSpaceModal/Utils';
import {
    toGroupGrants,
    toResourceAccessRows,
    type ResourceGrantState,
} from './resourceGrantState';

/**
 * Mirrors `GRANT_ACTION_TO_SPACE_ROLE` in the resolver: a grant is expressed in
 * the space role vocabulary rather than a parallel one, so a granted group reads
 * with the same words as a shared space. Only needed for groups -- a person's
 * row already carries the role the resolver decided.
 */
const GRANT_ACTION_ROLE: Record<ResourceAccessAction, SpaceMemberRole> = {
    view: SpaceMemberRole.VIEWER,
    manage: SpaceMemberRole.EDITOR,
};

/** A group grant is, definitionally, a grant on the resource. */
const GROUP_GRANT_ORIGIN = {
    hasDirectAccess: true,
    inheritedFrom: 'direct_resource',
} as const;

const roleTitle = (role: SpaceMemberRole): string =>
    UserAccessOptions.find((option) => option.value === role)?.title ?? role;

const resourceNoun = (resourceType: ResourceAccessResourceType): string => {
    switch (resourceType) {
        case 'Dashboard':
            return 'dashboard';
        case 'SavedChart':
            return 'chart';
        default:
            return assertUnreachable(
                resourceType,
                `Unknown resource type: ${resourceType}`,
            );
    }
};

/**
 * Deliberately never says "remove access". Removing a grant does not always end
 * access -- an inert grant sits under a role that already granted more, and a
 * group grant may reach the same person -- and the row cannot tell which case it
 * is in. Naming the grant is the only claim that is always true.
 */
const RevokeGrantButton: FC<{ disabled: boolean; onClick: () => void }> = ({
    disabled,
    onClick,
}) => (
    <Button
        variant="subtle"
        color="red"
        size="compact-xs"
        disabled={disabled}
        onClick={onClick}
    >
        Remove grant
    </Button>
);

/**
 * What this surface can do about a row, which is a question only the grant list
 * can answer -- see `toResourceAccessRows`.
 */
const revocableActions = (
    grant: ResourceGrantState,
): ResourceAccessAction[] | null => {
    switch (grant.kind) {
        case 'user_grant':
            return grant.actions;
        case 'no_user_grant':
            return null;
        default:
            return assertUnreachable(grant, 'Unknown resource grant state');
    }
};

const inheritanceCopy = (
    resourceType: ResourceAccessResourceType,
    spaceName: string | null,
): string => {
    const noun = resourceNoun(resourceType);
    const where = spaceName
        ? `the ${spaceName} space`
        : `the space this ${noun} lives in`;

    return `Only grants made here can be removed. Anyone with a project-wide role, or access to ${where}, keeps access to this ${noun}.`;
};

type ManageResourceAccessModalContentProps = {
    resourceType: ResourceAccessResourceType;
    /** Null when the caller does not know it; the copy still explains itself. */
    spaceName: string | null;
    /** One page of resolved access: everyone who can reach the resource. */
    shares: ResourceShare[];
    /** The grant rows behind it, which alone decide what can be removed. */
    grants: ResourceAccessList;
    /** Best-effort names. A group with no name is still listed, by uuid. */
    groupNames: Record<string, string>;
    sessionUserUuid: string | undefined;
    page: number;
    totalPages: number;
    isRevoking: boolean;
    onPageChange: (page: number) => void;
    onRevokeUser: (revoke: {
        userUuid: string;
        actions: ResourceAccessAction[];
    }) => void;
    onRevokeGroup: (revoke: {
        groupUuid: string;
        actions: ResourceAccessAction[];
    }) => void;
};

export const ManageResourceAccessModalContent: FC<
    ManageResourceAccessModalContentProps
> = ({
    resourceType,
    spaceName,
    shares,
    grants,
    groupNames,
    sessionUserUuid,
    page,
    totalPages,
    isRevoking,
    onPageChange,
    onRevokeUser,
    onRevokeGroup,
}) => {
    const rows = useMemo(
        () => toResourceAccessRows(shares, grants),
        [shares, grants],
    );
    const groupGrants = useMemo(() => toGroupGrants(grants), [grants]);

    return (
        <Stack gap="md">
            <Callout variant="info">
                <Text fz="xs">{inheritanceCopy(resourceType, spaceName)}</Text>
            </Callout>

            <AccessPanel
                page={page}
                totalPages={totalPages}
                onPageChange={onPageChange}
            >
                {rows.map(({ share, grant }) => {
                    const actions = revocableActions(grant);

                    return (
                        <PrincipalAccessRow
                            key={share.userUuid}
                            principal={toUserPrincipal(
                                share,
                                share.userUuid === sessionUserUuid,
                            )}
                            control={
                                <Group gap="xs" wrap="nowrap">
                                    <AccessOriginBadge
                                        origin={share}
                                        roleLabel={roleTitle(share.role)}
                                        color={getAccessColor(share.role).join(
                                            '.',
                                        )}
                                    />
                                    {actions && (
                                        <RevokeGrantButton
                                            disabled={isRevoking}
                                            onClick={() =>
                                                onRevokeUser({
                                                    userUuid: share.userUuid,
                                                    actions,
                                                })
                                            }
                                        />
                                    )}
                                </Group>
                            }
                        />
                    );
                })}
            </AccessPanel>

            {groupGrants.length > 0 && (
                <Stack gap={0}>
                    <Text fw={600} fz="xs" c="ldGray.6" mb="xs">
                        Groups with a grant
                    </Text>
                    {groupGrants.map(({ groupUuid, actions }) => {
                        // Most permissive first, so the highest is the first
                        const role = GRANT_ACTION_ROLE[actions[0]];

                        return (
                            <PrincipalAccessRow
                                key={groupUuid}
                                principal={{
                                    type: 'group',
                                    groupUuid,
                                    name: groupNames[groupUuid] ?? groupUuid,
                                }}
                                control={
                                    <Group gap="xs" wrap="nowrap">
                                        <AccessOriginBadge
                                            origin={GROUP_GRANT_ORIGIN}
                                            roleLabel={roleTitle(role)}
                                            color={getAccessColor(role).join(
                                                '.',
                                            )}
                                        />
                                        <RevokeGrantButton
                                            disabled={isRevoking}
                                            onClick={() =>
                                                onRevokeGroup({
                                                    groupUuid,
                                                    actions,
                                                })
                                            }
                                        />
                                    </Group>
                                }
                            />
                        );
                    })}
                </Stack>
            )}
        </Stack>
    );
};
