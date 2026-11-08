import { type DashboardRefreshInterval } from '@lightdash/common';
import {
    QueryClient,
    QueryClientProvider,
    useQuery,
} from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { type FC } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardTimeRangeAutoRefresh } from './DashboardTimeRangeAutoRefresh';

const mocks = vi.hoisted(() => ({ setIsAutoRefresh: vi.fn() }));

vi.mock('../../../providers/Dashboard/useDashboardTileStatusContext', () => ({
    default: (selector: (context: unknown) => unknown) =>
        selector({ setIsAutoRefresh: mocks.setIsAutoRefresh }),
}));

const fetchTileResults = vi.fn();
const fetchChart = vi.fn();

const Tile: FC = () => {
    const results = useQuery({
        queryKey: ['dashboard_chart_ready_query', 'tile-orders'],
        queryFn: fetchTileResults,
    });
    useQuery({
        queryKey: ['saved_query', 'chart-orders'],
        queryFn: fetchChart,
    });
    return <output data-testid="tile">{String(results.data ?? '')}</output>;
};

const renderDashboard = (refreshInterval: DashboardRefreshInterval | null) => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const ui = (interval: DashboardRefreshInterval | null) => (
        <QueryClientProvider client={client}>
            <DashboardTimeRangeAutoRefresh refreshInterval={interval} />
            <Tile />
        </QueryClientProvider>
    );
    const view = render(ui(refreshInterval));
    return {
        ...view,
        setRefreshInterval: (interval: DashboardRefreshInterval | null) =>
            view.rerender(ui(interval)),
    };
};

const flush = async (ms: number) => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
};

describe('DashboardTimeRangeAutoRefresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        let run = 0;
        fetchTileResults.mockReset().mockImplementation(async () => {
            run += 1;
            return `run ${run}`;
        });
        fetchChart.mockReset().mockResolvedValue('chart');
        mocks.setIsAutoRefresh.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-runs tile result queries every 10 seconds, not the chart definitions', async () => {
        const { setRefreshInterval } = renderDashboard('10s');
        await flush(0);
        expect(screen.getByTestId('tile')).toHaveTextContent('run 1');
        expect(mocks.setIsAutoRefresh).toHaveBeenLastCalledWith(true);

        await flush(9_999);
        expect(fetchTileResults).toHaveBeenCalledTimes(1);
        await flush(1);
        expect(fetchTileResults).toHaveBeenCalledTimes(2);
        await flush(10_000);
        expect(fetchTileResults).toHaveBeenCalledTimes(3);
        // Results are re-fetched in place, never removed, so the tile is not blanked.
        expect(screen.getByTestId('tile')).not.toBeEmptyDOMElement();
        expect(fetchChart).toHaveBeenCalledTimes(1);

        setRefreshInterval(null);
        expect(mocks.setIsAutoRefresh).toHaveBeenLastCalledWith(false);
        await flush(3_600_000);
        expect(fetchTileResults).toHaveBeenCalledTimes(3);
    });

    it('does nothing when refresh is off', async () => {
        renderDashboard(null);
        await flush(3_600_000);
        expect(fetchTileResults).toHaveBeenCalledTimes(1);
        expect(mocks.setIsAutoRefresh).not.toHaveBeenCalled();
    });
});
