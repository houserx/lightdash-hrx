// ldq-dashboard-auto-refresh: the dashboard refreshes its Tiles on the Dashboard Time Range's
// refresh interval, and never when refresh is off.
import { renderHook } from '@testing-library/react';
import { load } from './load';

let useDashboardAutoRefresh: any;

beforeAll(async () => {
    ({ useDashboardAutoRefresh } = await load(
        '../../features/dashboardTimeRange/hooks/useDashboardAutoRefresh',
    ));
}, 120_000);

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useDashboardAutoRefresh', () => {
    it('refreshes every interval', () => {
        const onRefresh = vi.fn();
        renderHook(() => useDashboardAutoRefresh('10s', onRefresh));
        vi.advanceTimersByTime(9_999);
        expect(onRefresh).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onRefresh).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(10_000);
        expect(onRefresh).toHaveBeenCalledTimes(2);
    });

    it('never refreshes when off', () => {
        const onRefresh = vi.fn();
        renderHook(() => useDashboardAutoRefresh(null, onRefresh));
        vi.advanceTimersByTime(3_600_000);
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('follows a changed interval and stops on unmount', () => {
        const onRefresh = vi.fn();
        const { rerender, unmount } = renderHook(
            ({ interval }: { interval: string | null }) =>
                useDashboardAutoRefresh(interval, onRefresh),
            { initialProps: { interval: '1m' as string | null } },
        );
        vi.advanceTimersByTime(30_000);
        rerender({ interval: '30s' });
        vi.advanceTimersByTime(30_000);
        expect(onRefresh).toHaveBeenCalledTimes(1);
        unmount();
        vi.advanceTimersByTime(600_000);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });
});
