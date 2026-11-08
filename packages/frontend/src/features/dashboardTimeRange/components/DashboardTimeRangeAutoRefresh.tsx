import { type DashboardRefreshInterval } from '@lightdash/common';
import { useEffect, type FC } from 'react';
import { useDashboardRefresh } from '../../../hooks/dashboard/useDashboardRefresh';
import useDashboardTileStatusContext from '../../../providers/Dashboard/useDashboardTileStatusContext';
import { useDashboardAutoRefresh } from '../hooks/useDashboardAutoRefresh';

type Props = {
    refreshInterval: DashboardRefreshInterval | null;
};

/**
 * Re-runs the dashboard's tile queries on the Dashboard Time Range's refresh
 * interval while it is mounted (view mode). Renders nothing.
 *
 * Tiles keep their results while re-fetching and the warehouse cache is not
 * bypassed: relative ranges resolve into refresh-interval buckets, so the
 * tile queries (and cache keys) change exactly when the data should.
 */
export const DashboardTimeRangeAutoRefresh: FC<Props> = ({
    refreshInterval,
}) => {
    const { invalidateDashboardResultsQueries } = useDashboardRefresh();
    const setIsAutoRefresh = useDashboardTileStatusContext(
        (c) => c.setIsAutoRefresh,
    );
    const isOn = refreshInterval !== null;

    // Tile queries run in the autorefreshed-dashboard context while refresh is on.
    useEffect(() => {
        if (!isOn) return;
        setIsAutoRefresh(true);
        return () => setIsAutoRefresh(false);
    }, [isOn, setIsAutoRefresh]);

    useDashboardAutoRefresh(refreshInterval, () => {
        void invalidateDashboardResultsQueries();
    });

    return null;
};
