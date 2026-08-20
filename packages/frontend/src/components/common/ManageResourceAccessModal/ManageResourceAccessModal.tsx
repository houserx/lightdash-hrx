import {
    type ResourceAccessAction,
    type ResourceAccessList,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import { IconUsers } from '@tabler/icons-react';
import { useCallback, useMemo, useState, type FC } from 'react';
import { useOrganizationGroups } from '../../../hooks/useOrganizationGroups';
import {
    useResourceAccess,
    useResourceGrants,
    useRevokeResourceGroupAccessMutation,
    useRevokeResourceUserAccessMutation,
} from '../../../hooks/useResourceAccess';
import useApp from '../../../providers/App/useApp';
import MantineModal from '../MantineModal';
import { ManageResourceAccessModalContent } from './ManageResourceAccessModalContent';

const PAGE_SIZE = 10;

/**
 * Nothing is removable until the grant list says so, so an unresolved query has
 * to read as "no grants" rather than as anything permissive.
 */
const NO_GRANTS: ResourceAccessList = { users: [], groups: [] };

type ManageResourceAccessModalProps = {
    opened: boolean;
    onClose: () => void;
    projectUuid: string;
    resourceType: ResourceAccessResourceType;
    resourceUuid: string;
    resourceName: string;
    /** The space the resource lives in, when the caller knows it. */
    spaceName: string | null;
};

export const ManageResourceAccessModal: FC<ManageResourceAccessModalProps> = ({
    opened,
    onClose,
    projectUuid,
    resourceType,
    resourceUuid,
    resourceName,
    spaceName,
}) => {
    const { user: sessionUser } = useApp();
    const [page, setPage] = useState(1);

    const { data: accessPage } = useResourceAccess(
        projectUuid,
        resourceType,
        resourceUuid,
        { page, pageSize: PAGE_SIZE },
        { enabled: opened },
    );

    const { data: grants } = useResourceGrants(
        projectUuid,
        resourceType,
        resourceUuid,
        { enabled: opened },
    );

    // Names only. A group missing from this list is still listed by uuid rather
    // than withheld, so the list never waits on -- or is trimmed by -- this query.
    // Gated like the others: this modal sits behind every dashboard and chart
    // action menu, and opening one of those should fetch nothing.
    const { data: organizationGroups } = useOrganizationGroups(
        {},
        { enabled: opened },
    );

    const revokeUser = useRevokeResourceUserAccessMutation(
        projectUuid,
        resourceType,
        resourceUuid,
    );
    const revokeGroup = useRevokeResourceGroupAccessMutation(
        projectUuid,
        resourceType,
        resourceUuid,
    );

    const groupNames = useMemo(
        () =>
            (organizationGroups ?? []).reduce<Record<string, string>>(
                (names, group) => ({ ...names, [group.uuid]: group.name }),
                {},
            ),
        [organizationGroups],
    );

    // Reset here rather than on open, per the frontend guide. Without it the page
    // survives a close, and reopening asks for a page the next resource may not
    // have.
    const handleClose = useCallback(() => {
        setPage(1);
        onClose();
    }, [onClose]);

    const handleRevokeUser = useCallback(
        (revoke: { userUuid: string; actions: ResourceAccessAction[] }) =>
            revokeUser.mutate(revoke),
        [revokeUser],
    );

    const handleRevokeGroup = useCallback(
        (revoke: { groupUuid: string; actions: ResourceAccessAction[] }) =>
            revokeGroup.mutate(revoke),
        [revokeGroup],
    );

    return (
        <MantineModal
            opened={opened}
            onClose={handleClose}
            title="Manage access"
            subtitle={resourceName}
            icon={IconUsers}
            size="lg"
            // Nothing here is staged, so there is nothing to cancel: one button
            // that closes. As the confirm rather than the cancel, because
            // MantineModal renders no footer at all without one.
            onConfirm={handleClose}
            confirmLabel="Done"
            cancelLabel={false}
        >
            <ManageResourceAccessModalContent
                resourceType={resourceType}
                spaceName={spaceName}
                shares={accessPage?.data ?? []}
                grants={grants ?? NO_GRANTS}
                groupNames={groupNames}
                sessionUserUuid={sessionUser.data?.userUuid}
                page={page}
                totalPages={accessPage?.pagination?.totalPageCount ?? 1}
                isRevoking={revokeUser.isLoading || revokeGroup.isLoading}
                onPageChange={setPage}
                onRevokeUser={handleRevokeUser}
                onRevokeGroup={handleRevokeGroup}
            />
        </MantineModal>
    );
};
