import { type DashboardTimeRange } from '@lightdash/common';
import { type FC } from 'react';
import { TimeRangePicker } from '../../timeRange/components/TimeRangePicker';
import { useDashboardTimeRangeUrlState } from '../hooks/useDashboardTimeRangeUrlState';

type Props = {
    savedTimeRange: DashboardTimeRange | null | undefined;
};

/**
 * Time range control for viewers of a dashboard with a saved time range.
 * The chosen range and refresh live in the URL (`from`, `to`, `refresh`).
 */
export const DashboardTimeRangeControl: FC<Props> = ({ savedTimeRange }) => {
    const { timeRange, setTimeRange } =
        useDashboardTimeRangeUrlState(savedTimeRange);

    if (!timeRange) return null;

    return (
        <TimeRangePicker
            value={{ from: timeRange.from, to: timeRange.to }}
            onChange={({ from, to }) =>
                setTimeRange({
                    from,
                    to,
                    refreshInterval: timeRange.refreshInterval,
                })
            }
            refreshInterval={timeRange.refreshInterval}
            onRefreshIntervalChange={(refreshInterval) =>
                setTimeRange({
                    from: timeRange.from,
                    to: timeRange.to,
                    refreshInterval,
                })
            }
        />
    );
};
