import { type QueryTimeRange } from '@lightdash/common';
import { useMemo } from 'react';
import { useLocation } from 'react-router';
import useDashboardContext from '../../../providers/Dashboard/useDashboardContext';
import { readTimeRangeFromSearchParams } from '../utils/urlState';

/**
 * The time range a dashboard's tile queries run over: the saved Dashboard
 * Time Range overridden by the URL's `from`, `to` and `refresh`, as the time
 * range control shows it. Undefined when the dashboard has no time range.
 * The backend resolves it once per query, so relative ranges move forward on
 * every refresh while the query key stays the same.
 */
export const useDashboardQueryTimeRange = (): QueryTimeRange | undefined => {
    const saved = useDashboardContext((c) => c.dashboard?.timeRange);
    const { search } = useLocation();

    return useMemo(() => {
        if (!saved) return undefined;
        const effective = readTimeRangeFromSearchParams(
            new URLSearchParams(search),
            saved,
        );
        if (!effective) return undefined;
        return {
            from: effective.from,
            to: effective.to,
            refreshInterval: effective.refreshInterval,
        };
    }, [saved, search]);
};
