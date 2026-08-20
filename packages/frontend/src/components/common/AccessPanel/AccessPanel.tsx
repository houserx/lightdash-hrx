import { type UserAvatarColorValue } from '@lightdash/common';
import {
    Avatar,
    Badge,
    Group,
    Stack,
    Text,
    type MantineColor,
} from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import {
    useCallback,
    type FC,
    type PropsWithChildren,
    type ReactNode,
} from 'react';
import { LightdashUserAvatar } from '../../Avatar';
import MantineIcon from '../MantineIcon';
import PaginateControl from '../PaginateControl';
import { getAccessOriginLabel, type AccessOrigin } from './accessOrigin';
import classes from './AccessPanel.module.css';

/**
 * The list of principals who can reach something, and what each of them can do
 * with it. Shared by space sharing and resource sharing: a resource grant
 * resolves into an ordinary access entry, so both surfaces answer the same
 * question and neither needs its own copy of these rows.
 */

/**
 * Users and groups are not the same shape and never will be -- a group has no
 * avatar to fall back on, cannot be the signed-in principal, and cannot be a
 * service account -- so the difference is a discriminant rather than a set of
 * fields that happen to be absent.
 *
 * Display names and initials are passed in rather than derived here; how a
 * principal is named is the surface's copy, not this component's.
 */
export type AccessPrincipal =
    | {
          type: 'user';
          userUuid: string;
          name: string | undefined;
          initials: string | undefined;
          avatarUrl: string | null;
          avatarGradient: UserAvatarColorValue | null;
          isServiceAccount: boolean;
          isSessionUser: boolean;
      }
    | {
          type: 'group';
          groupUuid: string;
          name: string;
      };

type AccessOriginBadgeProps = {
    origin: AccessOrigin;
    roleLabel: string;
    color: MantineColor;
};

export const AccessOriginBadge: FC<AccessOriginBadgeProps> = ({
    origin,
    roleLabel,
    color,
}) => (
    <Badge size="sm" variant="light" color={color} radius="xl">
        {getAccessOriginLabel(origin)} &middot; {roleLabel}
    </Badge>
);

const ServiceAccountBadge: FC = () => (
    <Badge size="xs" variant="light" color="violet" radius="sm">
        Service account
    </Badge>
);

const PrincipalAvatar: FC<{ principal: AccessPrincipal }> = ({ principal }) =>
    principal.type === 'group' ? (
        <Avatar size="sm" radius="xl" color="blue">
            <MantineIcon icon={IconUsers} size="sm" />
        </Avatar>
    ) : (
        <LightdashUserAvatar
            size="sm"
            tt="uppercase"
            userUuid={principal.userUuid}
            avatarUrl={principal.avatarUrl}
            avatarGradient={principal.avatarGradient}
        >
            {principal.initials}
        </LightdashUserAvatar>
    );

type PrincipalAccessRowProps = {
    principal: AccessPrincipal;
    /** Whatever this surface offers for the access: a role picker, a badge. */
    control: ReactNode;
    /**
     * Detail shown under the principal. Omitted means there is nothing more to
     * say, so the row stays a single line -- which is what lets a surface that
     * wants to explain where access comes from add it without changing the rest.
     */
    disclosure?: ReactNode;
};

export const PrincipalAccessRow: FC<PrincipalAccessRowProps> = ({
    principal,
    control,
    disclosure,
}) => (
    <Stack gap={0} className={classes.row}>
        <Group gap="sm" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
                <PrincipalAvatar principal={principal} />
                <Text fw={600} fz="sm" truncate>
                    {principal.name}
                    {principal.type === 'user' && principal.isSessionUser ? (
                        <Text fw={400} fz="sm" span c="ldGray.6">
                            {' '}
                            (you)
                        </Text>
                    ) : null}
                </Text>
                {principal.type === 'user' && principal.isServiceAccount ? (
                    <ServiceAccountBadge />
                ) : null}
            </Group>

            {control}
        </Group>

        {disclosure}
    </Stack>
);

type AccessPanelProps = PropsWithChildren<{
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
}>;

export const AccessPanel: FC<AccessPanelProps> = ({
    children,
    page,
    totalPages,
    onPageChange,
}) => {
    const handleNextPage = useCallback(() => {
        if (page < totalPages) onPageChange(page + 1);
    }, [page, totalPages, onPageChange]);

    const handlePreviousPage = useCallback(() => {
        if (page > 1) onPageChange(page - 1);
    }, [page, onPageChange]);

    return (
        <Stack gap="sm">
            {children}
            {totalPages > 1 && (
                <PaginateControl
                    currentPage={page}
                    totalPages={totalPages}
                    hasNextPage={page < totalPages}
                    hasPreviousPage={page > 1}
                    onNextPage={handleNextPage}
                    onPreviousPage={handlePreviousPage}
                    className={classes.pagination}
                />
            )}
        </Stack>
    );
};
