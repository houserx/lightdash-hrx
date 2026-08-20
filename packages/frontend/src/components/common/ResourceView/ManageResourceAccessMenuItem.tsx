import { Menu } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { type FC } from 'react';
import useApp from '../../../providers/App/useApp';
import MantineIcon from '../MantineIcon';
import { type ManageableAccessItem } from './manageResourceAccessTarget';
import {
    ResourceViewItemAction,
    type ResourceViewItemActionState,
} from './types';

type ManageResourceAccessMenuItemProps = {
    item: ManageableAccessItem;
    onAction: (action: ResourceViewItemActionState) => void;
};

/**
 * Own component rather than another branch in ResourceActionMenu because the
 * interesting decision is whether to render at all, and that is worth testing
 * without standing up the fifteen hooks that menu needs.
 *
 * "Manage access", not "Share": this surface reads grants and removes them.
 * Adding one comes with the principal picker.
 */
export const ManageResourceAccessMenuItem: FC<
    ManageResourceAccessMenuItemProps
> = ({ item, onAction }) => {
    const { health } = useApp();

    // Fail closed, and closed includes "health has not arrived". While the gate
    // is off, content permission checks skip the grant lookup, so anything done
    // here would change nobody's access.
    if (!health.data?.resourceGrants.enabled) {
        return null;
    }

    return (
        <Menu.Item
            component="button"
            role="menuitem"
            leftSection={<MantineIcon icon={IconUsers} size={18} />}
            onClick={() => {
                onAction({
                    type: ResourceViewItemAction.MANAGE_ACCESS,
                    item,
                });
            }}
        >
            Manage access
        </Menu.Item>
    );
};
