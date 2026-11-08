import { type DashboardTimeRange } from '@lightdash/common';
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
    readTimeRangeFromSearchParams,
    writeTimeRangeToSearchParams,
    type DashboardTimeRangeView,
} from '../utils/urlState';

/**
 * The Dashboard Time Range a viewer sees: the saved range overridden by the
 * URL's `from`, `to` and `refresh`. Changing it writes all three to the URL,
 * keeping other params, so the view can be shared.
 */
export const useDashboardTimeRangeUrlState = (
    saved: DashboardTimeRange | null | undefined,
) => {
    const { search, pathname } = useLocation();
    const navigate = useNavigate();

    const timeRange = useMemo(
        () => readTimeRangeFromSearchParams(new URLSearchParams(search), saved),
        [search, saved],
    );

    const setTimeRange = useCallback(
        (next: DashboardTimeRangeView) => {
            const params = writeTimeRangeToSearchParams(
                new URLSearchParams(search),
                next,
            );
            void navigate(
                { pathname, search: params.toString() },
                { replace: true },
            );
        },
        [navigate, pathname, search],
    );

    return { timeRange, setTimeRange };
};
