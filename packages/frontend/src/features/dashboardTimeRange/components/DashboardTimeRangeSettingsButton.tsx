import {
    type DashboardTile,
    type DashboardTileTimeDimension,
} from '@lightdash/common';
import { Button, Group, Loader, Text } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { useMemo, useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import MantineModal from '../../../components/common/MantineModal';
import useDashboardContext from '../../../providers/Dashboard/useDashboardContext';
import { getTimeRangeSettingsTiles } from '../utils/tileTimeDimensions';
import { DashboardTimeRangeSettings } from './DashboardTimeRangeSettings';

type Props = {
    tiles: DashboardTile[];
    value: Record<string, DashboardTileTimeDimension>;
    onChange: (value: Record<string, DashboardTileTimeDimension>) => void;
    disabled?: boolean;
};

/**
 * Edit-mode entry to the dashboard's time range settings. Changes are staged
 * with the rest of the dashboard edits and saved with "Save changes".
 */
export const DashboardTimeRangeSettingsButton: FC<Props> = ({
    tiles,
    value,
    onChange,
    disabled,
}) => {
    const [opened, setOpened] = useState(false);
    const filterableFieldsByTileUuid = useDashboardContext(
        (c) => c.filterableFieldsByTileUuid,
    );
    const settingsTiles = useMemo(
        () => getTimeRangeSettingsTiles(tiles, filterableFieldsByTileUuid),
        [tiles, filterableFieldsByTileUuid],
    );

    return (
        <>
            <Button
                variant="default"
                size="xs"
                disabled={disabled}
                leftSection={<MantineIcon icon={IconClock} />}
                onClick={() => setOpened(true)}
            >
                Time range settings
            </Button>
            {opened && (
                <MantineModal
                    opened
                    title="Time range settings"
                    subtitle="Pick the time dimension the dashboard time range filters on, for each tile."
                    icon={IconClock}
                    onClose={() => setOpened(false)}
                >
                    {filterableFieldsByTileUuid === undefined ? (
                        <Group gap="xs">
                            <Loader size="xs" />
                            <Text fz="sm" c="dimmed">
                                Loading the tiles' fields...
                            </Text>
                        </Group>
                    ) : (
                        <DashboardTimeRangeSettings
                            tiles={settingsTiles}
                            value={value}
                            onChange={onChange}
                        />
                    )}
                </MantineModal>
            )}
        </>
    );
};
