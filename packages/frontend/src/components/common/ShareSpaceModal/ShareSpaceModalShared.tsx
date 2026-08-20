import {
    OrganizationMemberRole,
    ProjectMemberRole,
    SpaceMemberRole,
    type LightdashUser,
    type Space,
    type SpaceGroup,
    type SpaceShare,
} from '@lightdash/common';
import {
    Avatar,
    Badge,
    Group,
    Paper,
    SegmentedControl,
    Select,
    Stack,
    Text,
    Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertCircle, IconLock, IconUsersGroup } from '@tabler/icons-react';
import chunk from 'lodash/chunk';
import { useMemo, useState, type FC } from 'react';
import { useUpdateMutation } from '../../../hooks/useSpaces';
import useApp from '../../../providers/App/useApp';
import { AccessPanel, PrincipalAccessRow } from '../AccessPanel/AccessPanel';
import Callout from '../Callout';
import MantineIcon from '../MantineIcon';
import MantineModal from '../MantineModal';
import { DEFAULT_PAGE_SIZE } from '../Table/constants';
import classes from './ShareSpaceModalShared.module.css';
import {
    getAccessColor,
    InheritanceType,
    NestedInheritanceOptions,
    RootInheritanceOptions,
} from './ShareSpaceModalUtils';
import { UserAccessAction, UserAccessOptions } from './ShareSpaceSelect';
import { toUserPrincipal } from './Utils';

type UserAccessListProps = {
    inheritParentPermissions: boolean;
    accessList: SpaceShare[];
    sessionUser: LightdashUser | undefined;
    onAccessChange: (action: UserAccessAction, user: SpaceShare) => void;
    disabled?: boolean;
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
};

export const UserAccessList: FC<UserAccessListProps> = ({
    inheritParentPermissions,
    accessList,
    sessionUser,
    onAccessChange,
    disabled = false,
    page,
    totalPages,
    onPageChange,
}) => {
    return (
        <AccessPanel
            page={page}
            totalPages={totalPages}
            onPageChange={onPageChange}
        >
            {accessList.map((sharedUser) => {
                const needsPromotion =
                    sharedUser.projectRole === ProjectMemberRole.VIEWER &&
                    sharedUser.role !== SpaceMemberRole.VIEWER;
                const isSessionUser =
                    sharedUser.userUuid === sessionUser?.userUuid;

                const userAccessTypes = UserAccessOptions.filter(
                    (t) =>
                        t.value !== UserAccessAction.DELETE ||
                        sharedUser.hasDirectAccess,
                ).map((t) =>
                    t.value === UserAccessAction.DELETE &&
                    inheritParentPermissions
                        ? {
                              ...t,
                              title: 'Reset access',
                              selectDescription: `Reset user's access`,
                          }
                        : t,
                );

                return (
                    <PrincipalAccessRow
                        key={sharedUser.userUuid}
                        principal={toUserPrincipal(sharedUser, isSessionUser)}
                        control={
                            isSessionUser || !sharedUser.hasDirectAccess ? (
                                <Badge
                                    size="sm"
                                    variant="light"
                                    color={getAccessColor(sharedUser.role).join(
                                        '.',
                                    )}
                                    radius="xl"
                                    mr="xs"
                                >
                                    {UserAccessOptions.find(
                                        (o) => o.value === sharedUser.role,
                                    )?.title ?? sharedUser.role}
                                </Badge>
                            ) : (
                                <Tooltip
                                    disabled={!needsPromotion}
                                    withinPortal
                                    label="User needs to be promoted to interactive viewer to have this space access"
                                    maw={350}
                                    multiline
                                >
                                    <Select
                                        classNames={{
                                            input: disabled
                                                ? undefined
                                                : classes.selectInput,
                                        }}
                                        size="xs"
                                        variant={
                                            disabled ? 'default' : 'unstyled'
                                        }
                                        comboboxProps={{ withinPortal: true }}
                                        data={userAccessTypes.map((u) => ({
                                            label: u.title,
                                            value: u.value,
                                        }))}
                                        value={sharedUser.role}
                                        renderOption={({ option }) => {
                                            const opt = userAccessTypes.find(
                                                (u) => u.value === option.value,
                                            );
                                            return (
                                                <Stack gap={1}>
                                                    <Text fz="sm">
                                                        {opt?.title}
                                                    </Text>
                                                    <Text
                                                        fz="xs"
                                                        opacity={0.65}
                                                    >
                                                        {opt?.selectDescription}
                                                    </Text>
                                                </Stack>
                                            );
                                        }}
                                        onChange={(value) => {
                                            if (value) {
                                                onAccessChange(
                                                    value as UserAccessAction,
                                                    sharedUser,
                                                );
                                            }
                                        }}
                                        error={needsPromotion}
                                        rightSection={
                                            needsPromotion ? (
                                                <MantineIcon
                                                    icon={IconAlertCircle}
                                                    size="sm"
                                                    color="red.6"
                                                />
                                            ) : null
                                        }
                                        disabled={disabled}
                                    />
                                </Tooltip>
                            )
                        }
                    />
                );
            })}
        </AccessPanel>
    );
};

type GroupAccessListProps = {
    disabled?: boolean;
    inheritParentPermissions: boolean;
    groupsAccess: SpaceGroup[];
    onAccessChange: (action: UserAccessAction, group: SpaceGroup) => void;
    pageSize?: number;
};

export const GroupsAccessList: FC<GroupAccessListProps> = ({
    disabled = false,
    inheritParentPermissions,
    onAccessChange,
    groupsAccess,
    pageSize,
}) => {
    const [page, setPage] = useState(1);

    const paginatedList: SpaceGroup[][] = useMemo(() => {
        return chunk(
            structuredClone(groupsAccess),
            pageSize ?? DEFAULT_PAGE_SIZE,
        );
    }, [groupsAccess, pageSize]);

    return (
        <AccessPanel
            page={page}
            totalPages={paginatedList.length}
            onPageChange={setPage}
        >
            {paginatedList[page - 1]?.map((group) => {
                const groupAccessTypes = UserAccessOptions.map((t) =>
                    t.value === UserAccessAction.DELETE
                        ? {
                              ...t,
                              title: inheritParentPermissions
                                  ? 'Reset access'
                                  : 'Remove access',
                              selectDescription: inheritParentPermissions
                                  ? `Reset group's access`
                                  : `Remove group's access`,
                          }
                        : t,
                );

                return (
                    <PrincipalAccessRow
                        key={group.groupUuid}
                        principal={{
                            type: 'group',
                            groupUuid: group.groupUuid,
                            name: group.groupName,
                        }}
                        control={
                            <Select
                                classNames={{
                                    input: disabled
                                        ? undefined
                                        : classes.selectInput,
                                }}
                                size="xs"
                                variant={disabled ? 'default' : 'unstyled'}
                                comboboxProps={{ withinPortal: true }}
                                data={groupAccessTypes.map((u) => ({
                                    label: u.title,
                                    value: u.value,
                                }))}
                                value={group.spaceRole}
                                renderOption={({ option }) => {
                                    const opt = groupAccessTypes.find(
                                        (u) => u.value === option.value,
                                    );
                                    return (
                                        <Stack gap={1}>
                                            <Text fz="sm">{opt?.title}</Text>
                                            <Text fz="xs" opacity={0.65}>
                                                {opt?.selectDescription}
                                            </Text>
                                        </Stack>
                                    );
                                }}
                                onChange={(value) => {
                                    if (value) {
                                        onAccessChange(
                                            value as UserAccessAction,
                                            group,
                                        );
                                    }
                                }}
                                disabled={disabled}
                            />
                        }
                    />
                );
            })}
        </AccessPanel>
    );
};

type AccessModelToggleProps = {
    space: Space;
    projectUuid: string;
    isNestedSpace: boolean;
};

export const AccessModelToggle: FC<AccessModelToggleProps> = ({
    space,
    projectUuid,
    isNestedSpace,
}) => {
    const { user: sessionUser } = useApp();
    const { mutate: spaceMutation, isLoading: isMutating } = useUpdateMutation(
        projectUuid,
        space.uuid,
    );
    const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
        useDisclosure(false);

    const showLockoutWarning = useMemo(() => {
        const userAccess = space.access.find(
            (a) => a.userUuid === sessionUser.data?.userUuid,
        );
        const hasDirectAccess = userAccess?.hasDirectAccess ?? false;
        const isAdmin = sessionUser.data?.role === OrganizationMemberRole.ADMIN;
        return !hasDirectAccess && !isAdmin;
    }, [space.access, sessionUser.data?.userUuid, sessionUser.data?.role]);

    const options = isNestedSpace
        ? NestedInheritanceOptions
        : RootInheritanceOptions;

    const currentValue = space.inheritParentPermissions
        ? InheritanceType.INHERIT
        : InheritanceType.OWN_ONLY;

    const currentOption =
        options.find((o) => o.value === currentValue) ?? options[0];

    const inheritDescription = useMemo(() => {
        if (currentValue !== InheritanceType.INHERIT) return undefined;
        const breadcrumbs = space.breadcrumbs ?? [];
        // Last breadcrumb is the current space, second-to-last is the parent
        const parent =
            breadcrumbs.length >= 2
                ? breadcrumbs[breadcrumbs.length - 2]
                : undefined;
        if (parent) {
            return `Inherits access from "${parent.name}"`;
        }
        return 'Inherits access from the project';
    }, [currentValue, space.breadcrumbs]);

    return (
        <>
            <Paper
                withBorder
                p="md"
                radius="md"
                className={classes.accessModelCard}
            >
                <Group justify="space-between" wrap="nowrap">
                    <Group gap="sm" wrap="nowrap">
                        <Avatar
                            radius="xl"
                            color={
                                currentValue === InheritanceType.INHERIT
                                    ? 'green'
                                    : 'orange'
                            }
                        >
                            <MantineIcon
                                icon={
                                    currentValue === InheritanceType.INHERIT
                                        ? IconUsersGroup
                                        : IconLock
                                }
                            />
                        </Avatar>
                        <Stack gap={2}>
                            <Text fw={600} fz="sm">
                                {currentOption.title}
                            </Text>
                            <Text c="ldGray.6" fz="xs">
                                {inheritDescription ??
                                    currentOption.description}
                            </Text>
                        </Stack>
                    </Group>

                    <SegmentedControl
                        size="xs"
                        radius="md"
                        value={currentValue}
                        classNames={{
                            root: classes.segmentedControl,
                        }}
                        onChange={(value) => {
                            const option = options.find(
                                (o) => o.value === value,
                            );
                            const inheritParentPermissions =
                                option?.value === InheritanceType.INHERIT;

                            if (
                                option &&
                                inheritParentPermissions !==
                                    space.inheritParentPermissions
                            ) {
                                if (!inheritParentPermissions) {
                                    openConfirm();
                                } else {
                                    spaceMutation({
                                        name: space.name,
                                        inheritParentPermissions,
                                    });
                                }
                            }
                        }}
                        data={options.map((o) => ({
                            value: o.value,
                            label: o.title,
                        }))}
                    />
                </Group>
            </Paper>

            <MantineModal
                opened={confirmOpened}
                onClose={closeConfirm}
                title="Restrict access?"
                onConfirm={() => {
                    spaceMutation({
                        name: space.name,
                        inheritParentPermissions: false,
                    });
                    closeConfirm();
                }}
                confirmLabel="Restrict access"
                confirmLoading={isMutating}
            >
                <Stack gap="sm">
                    <Text fz="sm">
                        Users with direct access will keep their access. Project
                        members will lose access unless specifically invited.
                    </Text>
                    {showLockoutWarning && (
                        <Callout variant="warning">
                            You don't have direct access to this space. Once
                            it's restricted, you won't be able to change this
                            setting again.
                        </Callout>
                    )}
                </Stack>
            </MantineModal>
        </>
    );
};
