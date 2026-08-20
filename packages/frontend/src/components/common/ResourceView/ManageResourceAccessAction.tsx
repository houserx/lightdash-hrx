import { type FC } from 'react';
import { useSpaceSummaries } from '../../../hooks/useSpaces';
import { ManageResourceAccessModal } from '../ManageResourceAccessModal/ManageResourceAccessModal';
import {
    toResourceAccessTarget,
    type ManageableAccessItem,
} from './manageResourceAccessTarget';

type ManageResourceAccessActionProps = {
    item: ManageableAccessItem;
    projectUuid: string;
    onClose: () => void;
};

/**
 * Sits between a content menu and the grants modal, and does one thing the menu
 * cannot: turn the item's space uuid into a space name.
 *
 * Unlike ShareSpaceAction it does not wait on that query. The space object *is*
 * the subject there; here the name is decoration on one line of copy, so the
 * modal opens immediately and the name arrives when it does.
 */
export const ManageResourceAccessAction: FC<
    ManageResourceAccessActionProps
> = ({ item, projectUuid, onClose }) => {
    const { resourceType, resourceUuid, spaceUuid } =
        toResourceAccessTarget(item);

    const { data: spaces } = useSpaceSummaries(projectUuid, true, {});

    // Absent rather than guessed. A private space the requester cannot see is
    // missing from this list, and naming another space would put the resource
    // somewhere it does not live.
    const spaceName =
        (spaces ?? []).find((space) => space.uuid === spaceUuid)?.name ?? null;

    return (
        <ManageResourceAccessModal
            opened
            onClose={onClose}
            projectUuid={projectUuid}
            resourceType={resourceType}
            resourceUuid={resourceUuid}
            resourceName={item.data.name}
            spaceName={spaceName}
        />
    );
};
