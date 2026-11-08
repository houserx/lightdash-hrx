// Dashboard time range settings: editors map each Tile to the time dimension
// the Dashboard Time Range filters on, or to None.
import { type DashboardTileTimeDimension } from '@lightdash/common';
import { Group, NativeSelect, Stack, Text } from '@mantine/core';
import { type FC } from 'react';
import { type TimeRangeSettingsTile } from '../utils/tileTimeDimensions';

const NONE = '';

type Props = {
    tiles: TimeRangeSettingsTile[];
    /** Time dimension per tile uuid; tiles not listed are not filtered. */
    value: Record<string, DashboardTileTimeDimension>;
    onChange: (value: Record<string, DashboardTileTimeDimension>) => void;
    disabled?: boolean;
};

export const DashboardTimeRangeSettings: FC<Props> = ({
    tiles,
    value,
    onChange,
    disabled,
}) => {
    const setTileTimeDimension = (
        tileUuid: string,
        timeDimension: DashboardTileTimeDimension | undefined,
    ) => {
        const { [tileUuid]: _previous, ...others } = value;
        onChange(
            timeDimension ? { ...others, [tileUuid]: timeDimension } : others,
        );
    };

    if (tiles.length === 0) {
        return (
            <Text fz="sm" c="dimmed">
                This dashboard has no tiles.
            </Text>
        );
    }

    return (
        <Stack gap="sm">
            {tiles.map((tile) => {
                const current = value[tile.uuid];
                if (tile.timeDimensions.length === 0 && !current) {
                    return (
                        <Group
                            key={tile.uuid}
                            justify="space-between"
                            wrap="nowrap"
                        >
                            <Text fz="sm" fw={500}>
                                {tile.name}
                            </Text>
                            <Text fz="sm" c="dimmed">
                                No time dimension
                            </Text>
                        </Group>
                    );
                }

                // A saved mapping stays visible even when the tile no longer
                // offers that dimension (or its fields are still loading).
                const options = [
                    ...tile.timeDimensions,
                    ...(current &&
                    !tile.timeDimensions.some(
                        (dimension) => dimension.fieldId === current.fieldId,
                    )
                        ? [{ ...current, label: current.fieldId }]
                        : []),
                ];

                return (
                    <NativeSelect
                        key={tile.uuid}
                        size="xs"
                        label={tile.name}
                        disabled={disabled}
                        value={current?.fieldId ?? NONE}
                        data={[
                            { value: NONE, label: 'None' },
                            ...options.map((dimension) => ({
                                value: dimension.fieldId,
                                label: dimension.label,
                            })),
                        ]}
                        onChange={(event) => {
                            const picked = options.find(
                                (dimension) =>
                                    dimension.fieldId ===
                                    event.currentTarget.value,
                            );
                            setTileTimeDimension(
                                tile.uuid,
                                picked && {
                                    fieldId: picked.fieldId,
                                    tableName: picked.tableName,
                                },
                            );
                        }}
                    />
                );
            })}
        </Stack>
    );
};
