import { Menu } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { type FC } from 'react';
import useApp from '../../../providers/App/useApp';
import MantineIcon from '../MantineIcon';

type ManageResourceAccessMenuItemProps = {
    onClick: () => void;
};

/**
 * The gate, the icon and the copy for managing a resource's direct grants, in
 * one place, so every menu that offers it agrees on all three.
 *
 * It takes a plain `onClick` because its callers want different things from a
 * click: a content list raises an action for its handler to switch on, while a
 * page header opens the modal from its own state. Knowing which would make this
 * component the wrong shape for one of them.
 *
 * "Manage access", not "Share": this surface reads grants and removes them.
 * Adding one comes with the principal picker.
 */
export const ManageResourceAccessMenuItem: FC<
    ManageResourceAccessMenuItemProps
> = ({ onClick }) => {
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
            onClick={onClick}
        >
            Manage access
        </Menu.Item>
    );
};
