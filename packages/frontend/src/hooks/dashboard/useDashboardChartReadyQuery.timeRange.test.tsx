import {
    DashboardTileTypes,
    type Dashboard,
    type DashboardTimeRange,
} from '@lightdash/common';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useEffect, type PropsWithChildren } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LightdashApi } from '../../api';
import AppProvider from '../../providers/App/AppProvider';
import DashboardProvider from '../../providers/Dashboard/DashboardProvider';
import useDashboardContext from '../../providers/Dashboard/useDashboardContext';
import { mockedLightdashApi } from '../../testing/mockedLightdashApi';
import { mockSavedChartResponse } from '../../testing/savedChartResponse.mock';
import { useDashboardChartReadyQuery } from './useDashboardChartReadyQuery';

vi.mock('../../api');

const projectUuid = '9a0b7a3c-0000-4000-8000-000000000002';
const chart = mockSavedChartResponse({
    uuid: 'chart-uuid',
    projectUuid,
    slug: 'orders',
    name: 'Orders',
    tableName: 'orders',
    updatedAt: new Date('2026-10-01'),
    metricQuery: {
        exploreName: 'orders',
        dimensions: [],
        metrics: [],
        filters: {},
        sorts: [],
        limit: 500,
        tableCalculations: [],
    },
    tableConfig: { columnOrder: [] },
});

const savedTimeRange: DashboardTimeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: '1m',
    tileTimeDimensions: {
        'tile-uuid': { fieldId: 'orders_created_at', tableName: 'orders' },
    },
};

const baseDashboard: Dashboard = {
    uuid: 'dashboard-uuid',
    projectUuid,
    slug: 'orders-dashboard',
    name: 'Orders dashboard',
    organizationUuid: chart.organizationUuid,
    dashboardVersionId: 1,
    versionUuid: 'dashboard-version',
    verification: null,
    updatedAt: new Date('2026-10-01'),
    spaceUuid: 'space',
    spaceName: 'Space',
    views: 0,
    firstViewedAt: null,
    pinnedListUuid: null,
    pinnedListOrder: null,
    inheritsFromOrgOrProject: false,
    access: [],
    colorPaletteUuid: null,
    owner: null,
    tabs: [],
    filters: { dimensions: [], metrics: [], tableCalculations: [] },
    tiles: [
        {
            uuid: 'tile-uuid',
            tabUuid: null,
            type: DashboardTileTypes.SAVED_CHART,
            x: 0,
            y: 0,
            w: 12,
            h: 6,
            properties: {
                savedChartUuid: chart.uuid,
                chartSlug: chart.slug,
            },
        },
    ],
} as unknown as Dashboard;

let dashboard: Dashboard = baseDashboard;
let tileQueryBodies: Record<string, unknown>[] = [];

beforeEach(() => {
    dashboard = baseDashboard;
    tileQueryBodies = [];
    mockedLightdashApi.mockImplementation((async ({ url, body }) => {
        if (url.startsWith(`/projects/${projectUuid}/dashboards/`)) {
            return dashboard;
        }
        if (url.startsWith(`/projects/${projectUuid}/saved/`)) {
            return chart;
        }
        if (url === `/projects/${projectUuid}/explores/orders`) {
            return { name: 'orders', tables: {}, baseTable: 'orders' };
        }
        if (url === `/projects/${projectUuid}/query/dashboard-chart`) {
            tileQueryBodies.push(JSON.parse(body as string));
            return { queryUuid: 'query-uuid' };
        }
        return new Promise(() => {});
    }) as LightdashApi);
});

afterEach(() => {
    cleanup();
});

const renderTileQuery = (search = '') => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>
            <AppProvider>
                <MemoryRouter
                    initialEntries={[
                        `/projects/${projectUuid}/dashboards/${dashboard.slug}${search}`,
                    ]}
                >
                    <Routes>
                        <Route
                            path="/projects/:projectUuid/dashboards/:dashboardUuid"
                            element={
                                <DashboardProvider projectUuid={projectUuid}>
                                    {children}
                                </DashboardProvider>
                            }
                        />
                    </Routes>
                </MemoryRouter>
            </AppProvider>
        </QueryClientProvider>
    );
    return renderHook(
        () => {
            const currentDashboard = useDashboardContext((c) => c.dashboard);
            const setDashboardTiles = useDashboardContext(
                (c) => c.setDashboardTiles,
            );
            useEffect(() => {
                if (currentDashboard) setDashboardTiles(currentDashboard.tiles);
            }, [currentDashboard, setDashboardTiles]);
            return useDashboardChartReadyQuery('tile-uuid', chart.uuid);
        },
        { wrapper },
    );
};

describe('dashboard chart tile query time range', () => {
    it('sends the saved Dashboard Time Range with the tile query', async () => {
        dashboard = { ...baseDashboard, timeRange: savedTimeRange };
        const { result } = renderTileQuery();

        await waitFor(() => expect(result.current.data).toBeDefined());
        expect(tileQueryBodies.at(-1)).toMatchObject({
            tileUuid: 'tile-uuid',
            timeRange: { from: 'now-6h', to: 'now', refreshInterval: '1m' },
        });
        expect(tileQueryBodies.at(-1)?.timeRange).not.toHaveProperty(
            'tileTimeDimensions',
        );
    });

    it('sends the range from the URL over the saved one', async () => {
        dashboard = { ...baseDashboard, timeRange: savedTimeRange };
        const { result } = renderTileQuery(
            '?from=2026-11-01T00:00:00.000Z&to=2026-11-02T00:00:00.000Z&refresh=off',
        );

        await waitFor(() => expect(result.current.data).toBeDefined());
        expect(tileQueryBodies.at(-1)).toMatchObject({
            timeRange: {
                from: '2026-11-01T00:00:00.000Z',
                to: '2026-11-02T00:00:00.000Z',
                refreshInterval: null,
            },
        });
    });

    it('sends no time range for a dashboard without one', async () => {
        const { result } = renderTileQuery('?from=now-1h&to=now');

        await waitFor(() => expect(result.current.data).toBeDefined());
        expect(tileQueryBodies.at(-1)).toBeDefined();
        expect(tileQueryBodies.at(-1)).not.toHaveProperty('timeRange');
    });
});
