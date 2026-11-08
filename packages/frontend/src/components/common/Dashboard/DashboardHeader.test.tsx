import {
    DimensionType,
    FieldType,
    type Dashboard,
    type DashboardFilterableField,
    type DashboardTileTimeDimension,
} from '@lightdash/common';
import { act, fireEvent, screen } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../testing/testUtils';
import DashboardHeader from './DashboardHeader';

const mocks = vi.hoisted(() => ({
    flagEnabled: true,
    userCanManageDashboard: true,
    filterableFieldsByTileUuid: undefined as
        | Record<string, DashboardFilterableField[]>
        | undefined,
    invalidateDashboardResultsQueries: vi.fn(),
    setIsAutoRefresh: vi.fn(),
}));

vi.mock('../../../providers/Dashboard/useDashboardContext', () => ({
    default: (selector: (context: unknown) => unknown) =>
        selector({
            filterableFieldsByTileUuid: mocks.filterableFieldsByTileUuid,
        }),
}));

vi.mock('../../../providers/Dashboard/useDashboardTileStatusContext', () => ({
    default: (selector: (context: unknown) => unknown) =>
        selector({ setIsAutoRefresh: mocks.setIsAutoRefresh }),
}));
vi.mock('../../../hooks/dashboard/useDashboardRefresh', () => ({
    useDashboardRefresh: () => ({
        invalidateDashboardResultsQueries:
            mocks.invalidateDashboardResultsQueries,
    }),
}));

vi.mock('../../../hooks/useServerOrClientFeatureFlag', () => ({
    useServerFeatureFlag: () => ({ data: { enabled: mocks.flagEnabled } }),
}));
vi.mock('../../../hooks/useProjectRoute', () => ({
    useProjectUrlIdentifier: () => 'project-slug',
    useOptionalProjectRoute: () => undefined,
}));
vi.mock('./useDashboardManageAccess', () => ({
    useDashboardManageAccess: () => ({
        hasDashboardManageAbility: mocks.userCanManageDashboard,
        userCanManageDashboard: mocks.userCanManageDashboard,
    }),
}));
vi.mock('../../../features/comments', () => ({
    DashboardCommentsPanel: () => null,
    useDashboardCommentsSummary: () => ({
        canViewDashboardComments: false,
        openThreadCount: 0,
        unreadCount: 0,
        markAllAsViewed: vi.fn(),
    }),
}));
vi.mock('../../../ee/features/contentReview', () => ({
    PendingReviewBadge: () => null,
    RequestReviewModal: () => null,
    useContentReviewEligibility: () => ({ pendingRequest: null }),
}));
vi.mock('../../DashboardTiles/AddTileButton', () => ({ default: () => null }));
vi.mock('./DashboardRefreshButton', () => ({
    DashboardRefreshButton: () => null,
}));
vi.mock('./DashboardPerformanceWarning', () => ({
    DashboardPerformanceWarning: () => null,
}));

const renderHeader = (isEditMode: boolean) =>
    renderWithProviders(
        <MemoryRouter>
            <DashboardHeader
                {...({
                    dashboard: {
                        uuid: 'dashboard-uuid',
                        slug: 'weekly-revenue',
                        name: 'Weekly revenue',
                        tiles: [],
                        tabs: [],
                        access: [],
                    } as unknown as Dashboard,
                    isEditMode,
                    hasDashboardChanged: false,
                    isSaving: false,
                    isFullscreen: false,
                    isMovingDashboardToSpace: false,
                    isFitToScreen: false,
                    isFitToScreenAvailable: false,
                } as ComponentProps<typeof DashboardHeader>)}
            />
        </MemoryRouter>,
    );

describe('DashboardHeader editing badge', () => {
    beforeEach(() => {
        mocks.flagEnabled = true;
        mocks.userCanManageDashboard = true;
    });

    it('shows the badge and the edit details button while editing', () => {
        renderHeader(true);
        expect(screen.getByText('Editing')).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Edit details' }),
        ).toBeInTheDocument();
    });

    it('hides the badge when the dashboard controls flag is off', () => {
        mocks.flagEnabled = false;
        renderHeader(true);
        expect(screen.queryByText('Editing')).not.toBeInTheDocument();
    });

    it('hides the badge in view mode', () => {
        renderHeader(false);
        expect(screen.queryByText('Editing')).not.toBeInTheDocument();
    });

    it('hides the badge from a user who cannot manage the dashboard', () => {
        mocks.userCanManageDashboard = false;
        renderHeader(true);
        expect(screen.queryByText('Editing')).not.toBeInTheDocument();
    });
});

const LocationProbe = () => {
    const { search } = useLocation();
    return <output data-testid="search">{search}</output>;
};

const renderHeaderWithTimeRange = ({
    url,
    isEditMode = false,
}: {
    url: string;
    isEditMode?: boolean;
}) =>
    renderWithProviders(
        <MemoryRouter initialEntries={[url]}>
            <DashboardHeader
                {...({
                    dashboard: {
                        uuid: 'dashboard-uuid',
                        slug: 'weekly-revenue',
                        name: 'Weekly revenue',
                        tiles: [],
                        tabs: [],
                        access: [],
                        timeRange: {
                            from: 'now-6h',
                            to: 'now',
                            refreshInterval: '1m',
                            tileTimeDimensions: {},
                        },
                    } as unknown as Dashboard,
                    isEditMode,
                    hasDashboardChanged: false,
                    isSaving: false,
                    isFullscreen: false,
                    isMovingDashboardToSpace: false,
                    isFitToScreen: false,
                    isFitToScreenAvailable: false,
                } as ComponentProps<typeof DashboardHeader>)}
            />
            <LocationProbe />
        </MemoryRouter>,
    );

describe('DashboardHeader time range in the URL', () => {
    beforeEach(() => {
        mocks.flagEnabled = true;
        mocks.userCanManageDashboard = true;
    });

    it('writes a changed range to the URL and keeps other params', async () => {
        renderHeaderWithTimeRange({ url: '/dashboards/d?tab=overview' });
        expect(screen.getByTestId('search')).toHaveTextContent('?tab=overview');

        fireEvent.click(screen.getByRole('button', { name: /Last 6 hours/ }));
        fireEvent.click(await screen.findByText('Last 15 minutes'));

        const params = new URLSearchParams(
            screen.getByTestId('search').textContent ?? '',
        );
        expect(params.get('tab')).toBe('overview');
        expect(params.get('from')).toBe('now-15m');
        expect(params.get('to')).toBe('now');
        expect(params.get('refresh')).toBe('1m');
        expect(
            screen.getByRole('button', { name: /Last 15 minutes/ }),
        ).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Refresh'), {
            target: { value: 'off' },
        });
        expect(
            new URLSearchParams(
                screen.getByTestId('search').textContent ?? '',
            ).get('refresh'),
        ).toBe('off');
    });

    it('shows the range from a shared URL over the saved one', () => {
        renderHeaderWithTimeRange({
            url: '/dashboards/d?from=now-24h&to=now&refresh=5m',
        });
        expect(
            screen.getByRole('button', { name: /Last 24 hours/ }),
        ).toBeInTheDocument();
        expect(screen.getByLabelText('Refresh')).toHaveValue('5m');
    });

    it('has no time range control in edit mode', () => {
        renderHeaderWithTimeRange({ url: '/dashboards/d', isEditMode: true });
        expect(
            screen.queryByRole('button', { name: /Last 6 hours/ }),
        ).not.toBeInTheDocument();
    });
});

describe('DashboardHeader auto-refresh', () => {
    beforeEach(() => {
        mocks.flagEnabled = true;
        mocks.userCanManageDashboard = true;
        mocks.invalidateDashboardResultsQueries.mockClear();
        mocks.setIsAutoRefresh.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refreshes the tiles every 10 seconds until refresh is set to Off', () => {
        renderHeaderWithTimeRange({ url: '/dashboards/d' });
        fireEvent.change(screen.getByLabelText('Refresh'), {
            target: { value: '10s' },
        });
        expect(mocks.setIsAutoRefresh).toHaveBeenLastCalledWith(true);

        act(() => {
            vi.advanceTimersByTime(9_999);
        });
        expect(mocks.invalidateDashboardResultsQueries).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(mocks.invalidateDashboardResultsQueries).toHaveBeenCalledTimes(
            1,
        );
        act(() => {
            vi.advanceTimersByTime(20_000);
        });
        expect(mocks.invalidateDashboardResultsQueries).toHaveBeenCalledTimes(
            3,
        );

        fireEvent.change(screen.getByLabelText('Refresh'), {
            target: { value: 'off' },
        });
        expect(mocks.setIsAutoRefresh).toHaveBeenLastCalledWith(false);
        act(() => {
            vi.advanceTimersByTime(3_600_000);
        });
        expect(mocks.invalidateDashboardResultsQueries).toHaveBeenCalledTimes(
            3,
        );
    });

    it('stops refreshing when the viewer leaves the dashboard', () => {
        const { unmount } = renderHeaderWithTimeRange({
            url: '/dashboards/d?refresh=10s',
        });
        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        expect(mocks.invalidateDashboardResultsQueries).toHaveBeenCalledTimes(
            1,
        );

        unmount();
        expect(mocks.setIsAutoRefresh).toHaveBeenLastCalledWith(false);
        act(() => {
            vi.advanceTimersByTime(600_000);
        });
        expect(mocks.invalidateDashboardResultsQueries).toHaveBeenCalledTimes(
            1,
        );
    });

    it('does not refresh in edit mode', () => {
        renderHeaderWithTimeRange({
            url: '/dashboards/d?refresh=10s',
            isEditMode: true,
        });
        act(() => {
            vi.advanceTimersByTime(600_000);
        });
        expect(mocks.invalidateDashboardResultsQueries).not.toHaveBeenCalled();
    });
});

const timeDimension = (name: string, label: string) =>
    ({
        fieldType: FieldType.DIMENSION,
        type: DimensionType.TIMESTAMP,
        name,
        label,
        table: 'orders',
        tableLabel: 'Orders',
        sql: '',
        hidden: false,
    }) as DashboardFilterableField;

const timeRangeDashboard = {
    uuid: 'dashboard-uuid',
    slug: 'weekly-revenue',
    name: 'Weekly revenue',
    tabs: [],
    access: [],
    tiles: [],
    timeRange: {
        from: 'now-6h',
        to: 'now',
        refreshInterval: '1m',
        tileTimeDimensions: {
            'tile-orders': {
                fieldId: 'orders_created_at',
                tableName: 'orders',
            },
        },
    },
} as unknown as Dashboard;

const dashboardTiles = [
    {
        uuid: 'tile-orders',
        type: 'saved_chart',
        properties: { title: '', chartName: 'Orders per hour' },
    },
    { uuid: 'tile-note', type: 'markdown', properties: { title: 'Runbook' } },
] as unknown as Dashboard['tiles'];

const staged: {
    current: Record<string, DashboardTileTimeDimension> | undefined;
} = { current: undefined };

// Holds the staged mapping like the dashboard page does
const EditingHeader = ({ dashboard }: { dashboard: Dashboard }) => {
    const [tileTimeDimensions, setTileTimeDimensions] =
        useState<Record<string, DashboardTileTimeDimension>>();
    staged.current = tileTimeDimensions;
    return (
        <DashboardHeader
            {...({
                dashboard,
                dashboardTiles,
                isEditMode: true,
                hasDashboardChanged: false,
                isSaving: false,
                isFullscreen: false,
                isMovingDashboardToSpace: false,
                isFitToScreen: false,
                isFitToScreenAvailable: false,
                tileTimeDimensions,
                onTileTimeDimensionsChange: setTileTimeDimensions,
            } as ComponentProps<typeof DashboardHeader>)}
        />
    );
};

describe('DashboardHeader time range settings', () => {
    beforeEach(() => {
        mocks.flagEnabled = true;
        mocks.userCanManageDashboard = true;
        mocks.filterableFieldsByTileUuid = {
            'tile-orders': [
                timeDimension('created_at', 'Created at'),
                timeDimension('shipped_at', 'Shipped at'),
            ],
        };
        staged.current = undefined;
    });

    it('lets an editor map, change and clear tile time dimensions', async () => {
        renderWithProviders(
            <MemoryRouter>
                <EditingHeader dashboard={timeRangeDashboard} />
            </MemoryRouter>,
        );

        fireEvent.click(
            screen.getByRole('button', { name: 'Time range settings' }),
        );
        const select = await screen.findByLabelText('Orders per hour');
        expect(select).toHaveValue('orders_created_at');
        expect(screen.getByText('Runbook')).toBeInTheDocument();
        expect(screen.getByText('No time dimension')).toBeInTheDocument();

        fireEvent.change(select, { target: { value: 'orders_shipped_at' } });
        expect(staged.current).toEqual({
            'tile-orders': {
                fieldId: 'orders_shipped_at',
                tableName: 'orders',
            },
        });
        expect(screen.getByLabelText('Orders per hour')).toHaveValue(
            'orders_shipped_at',
        );

        fireEvent.change(screen.getByLabelText('Orders per hour'), {
            target: { value: '' },
        });
        expect(staged.current).toEqual({});
        expect(screen.getByLabelText('Orders per hour')).toHaveValue('');
    });

    it('waits for the tile fields before listing tiles', async () => {
        mocks.filterableFieldsByTileUuid = undefined;
        renderWithProviders(
            <MemoryRouter>
                <EditingHeader dashboard={timeRangeDashboard} />
            </MemoryRouter>,
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Time range settings' }),
        );
        expect(
            await screen.findByText("Loading the tiles' fields..."),
        ).toBeInTheDocument();
        expect(screen.queryByText('No time dimension')).not.toBeInTheDocument();
    });

    it('offers no settings on a dashboard without a time range', () => {
        renderWithProviders(
            <MemoryRouter>
                <EditingHeader
                    dashboard={
                        {
                            ...timeRangeDashboard,
                            timeRange: null,
                        } as Dashboard
                    }
                />
            </MemoryRouter>,
        );
        expect(
            screen.queryByRole('button', { name: 'Time range settings' }),
        ).not.toBeInTheDocument();
    });
});
