import {
    ChartKind,
    DashboardTileTypes,
    type DashboardSqlChartTile as DashboardSqlChartTileType,
    type DashboardTimeRange,
} from '@lightdash/common';
import { cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardTestStore } from '../../testing/dashboardStore';
import { DashboardStoreTestProvider } from '../../testing/DashboardStoreTestProvider';
import { renderWithProviders } from '../../testing/testUtils';
import DashboardSqlChartTile from './DashboardSqlChartTile';

const mocks = vi.hoisted(() => ({
    timeRange: undefined as DashboardTimeRange | undefined,
    sql: 'SELECT 1',
}));

// The tile is rendered with its chart already fetched; nothing may reach the network.
vi.mock('../../api');
vi.mock('../../features/sqlRunner/hooks/useSavedSqlChartResults', () => ({
    useSavedSqlChartResults: () => ({
        chartQuery: {
            data: {
                sql: mocks.sql,
                slug: 'up-over-time',
                config: { type: ChartKind.VERTICAL_BAR },
                warehouseConnectionUuid: null,
                organization: { organizationUuid: 'org-uuid' },
                project: { projectUuid: 'project-uuid' },
            },
            isLoading: false,
            error: null,
        },
        // Results still running: the tile header is already shown.
        chartResultsQuery: {
            data: undefined,
            isLoading: true,
            error: null,
            isFetching: true,
        },
        getDownloadQueryUuid: async () => 'query-uuid',
    }),
}));
vi.mock('../../hooks/useConnectionBadges', () => ({
    useConnectionBadges: () => undefined,
}));
vi.mock('../../hooks/useProjectUuid', () => ({
    useProjectUuid: () => 'project-uuid',
}));
vi.mock('../../hooks/dashboard/useDashboardFiltersForTile', () => ({
    default: () => undefined,
}));
vi.mock('../../providers/Dashboard/useRegisterTileQuery', () => ({
    useRegisterTileQuery: () => {},
}));
vi.mock('../../providers/Dashboard/useDashboardContext', () => ({
    default: vi.fn((selector: (value: Record<string, unknown>) => unknown) =>
        selector({
            dashboard: {
                uuid: 'dashboard-uuid',
                timeRange: mocks.timeRange,
            },
            addParameterReferences: () => {},
        }),
    ),
}));
vi.mock('../../providers/Dashboard/useDashboardTileStatusContext', () => ({
    default: vi.fn((selector: (value: Record<string, unknown>) => unknown) =>
        selector({
            updateSqlChartTilesMetadata: () => {},
            markTileScreenshotReady: () => {},
            markTileScreenshotErrored: () => {},
            markEmbedTileComplete: () => {},
        }),
    ),
}));

const tile: DashboardSqlChartTileType = {
    uuid: 'tile-sql',
    type: DashboardTileTypes.SQL_CHART,
    x: 0,
    y: 0,
    h: 4,
    w: 6,
    tabUuid: undefined,
    properties: {
        savedSqlUuid: 'sql-uuid',
        chartName: 'Up over time',
        title: 'Up over time',
    },
};

const timeRange: DashboardTimeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: null,
    tileTimeDimensions: {
        'tile-orders': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

const renderTile = () =>
    renderWithProviders(
        <DashboardStoreTestProvider store={createDashboardTestStore({})}>
            <MemoryRouter>
                <DashboardSqlChartTile
                    tile={tile}
                    isEditMode={false}
                    onDelete={() => {}}
                    onEdit={() => {}}
                />
            </MemoryRouter>
        </DashboardStoreTestProvider>,
    );

describe('DashboardSqlChartTile under a dashboard time range', () => {
    afterEach(() => {
        mocks.timeRange = undefined;
        mocks.sql = 'SELECT 1';
        cleanup();
    });

    it('marks SQL without the reserved time parameters as not affected', () => {
        mocks.timeRange = timeRange;
        mocks.sql = 'SELECT status, count(*) FROM orders GROUP BY 1';
        renderTile();

        expect(screen.getByText('Up over time')).toBeInTheDocument();
        expect(
            screen.getByText('Not affected by the time range'),
        ).toBeInTheDocument();
    });

    it('shows no mark on telemetry SQL using the reserved time parameters', () => {
        mocks.timeRange = timeRange;
        mocks.sql =
            "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})";
        renderTile();

        expect(screen.getByText('Up over time')).toBeInTheDocument();
        expect(
            screen.queryByText('Not affected by the time range'),
        ).not.toBeInTheDocument();
    });

    it('shows no mark when the dashboard has no time range', () => {
        renderTile();

        expect(screen.getByText('Up over time')).toBeInTheDocument();
        expect(
            screen.queryByText('Not affected by the time range'),
        ).not.toBeInTheDocument();
    });
});
