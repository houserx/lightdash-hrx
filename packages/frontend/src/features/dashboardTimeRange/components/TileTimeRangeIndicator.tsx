// Marks a dashboard tile the Dashboard Time Range does not reach, so viewers
// know its data ignores the picked range.
import { type IsTileAffectedByTimeRangeArgs } from '@lightdash/common';
import { Badge, Tooltip } from '@mantine/core';
import { IconClockOff } from '@tabler/icons-react';
import { type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import { isTileMarkedNotAffectedByTimeRange } from '../utils/tileTimeRangeIndicator';

export const TileTimeRangeIndicator: FC<IsTileAffectedByTimeRangeArgs> = ({
    timeRange,
    tile,
    sql,
}) => {
    if (!isTileMarkedNotAffectedByTimeRange({ timeRange, tile, sql })) {
        return null;
    }

    return (
        <Tooltip
            label="This tile has no time dimension for the dashboard time range"
            withinPortal
        >
            <Badge
                variant="light"
                color="gray"
                size="sm"
                radius="sm"
                tt="none"
                leftSection={<MantineIcon icon={IconClockOff} size={12} />}
            >
                Not affected by the time range
            </Badge>
        </Tooltip>
    );
};
