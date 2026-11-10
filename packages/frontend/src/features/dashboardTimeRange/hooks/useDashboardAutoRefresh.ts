import {
    isDashboardRefreshInterval,
    parseTimeRangeDuration,
} from '@lightdash/common';
import { useEffect } from 'react';
import { useStableCallback } from '../../../hooks/useStableCallback';

/**
 * Calls `onRefresh` every `refreshInterval` (one of the Dashboard Time Range
 * refresh intervals, e.g. `10s`). `null`, `undefined` or an unknown interval
 * means refresh is off. A changed interval restarts the timer, and unmounting
 * stops it. `onRefresh` may change between renders without restarting it.
 */
export const useDashboardAutoRefresh = (
    refreshInterval: string | null | undefined,
    onRefresh: () => void,
) => {
    const tick = useStableCallback(onRefresh);
    const intervalMs = isDashboardRefreshInterval(refreshInterval)
        ? parseTimeRangeDuration(refreshInterval)
        : null;

    useEffect(() => {
        if (intervalMs === null) return;
        const id = setInterval(tick, intervalMs);
        return () => clearInterval(id);
    }, [intervalMs, tick]);
};
