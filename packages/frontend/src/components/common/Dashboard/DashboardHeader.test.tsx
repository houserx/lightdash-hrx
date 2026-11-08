import { type Dashboard } from '@lightdash/common';
import { fireEvent, screen } from '@testing-library/react';
import { type ComponentProps } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../testing/testUtils';
import DashboardHeader from './DashboardHeader';

const mocks = vi.hoisted(() => ({
    flagEnabled: true,
    userCanManageDashboard: true,
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
