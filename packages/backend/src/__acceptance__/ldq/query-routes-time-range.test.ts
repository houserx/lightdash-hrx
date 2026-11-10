// ldq-query-routes-time-range-audit: the async query routes accept the Dashboard Time Range /
// Investigate range and the Audited Query fields, and hand them to AsyncQueryService, which
// resolves the reserved time parameters before compile and puts the audit block in the
// identity token.
import type { RequestHandler } from 'express';
import { buildRouteApp, PROJECT_UUID } from './routeHarness';

vi.mock('../../controllers/authentication', async (importOriginal) => {
    const original = await importOriginal<any>();
    const pass: RequestHandler = (_request, _response, next) => next();
    return {
        ...original,
        allowApiKeyAuthentication: pass,
        isAuthenticated: pass,
        unauthorisedInDemo: pass,
    };
});

const queued = {
    queryUuid: '00000000-0000-4000-8000-000000000123',
    cacheMetadata: { cacheHit: false },
    metricQuery: {},
    fields: {},
};

const fakeAsyncQueryService = () => ({
    executeAsyncSqlQuery: vi.fn(async () => queued),
    executeAsyncDashboardSqlChartQuery: vi.fn(async () => queued),
    executeAsyncDashboardChartQuery: vi.fn(async () => queued),
    redactFieldsSqlForResponse: vi.fn(
        (_account: unknown, _projectUuid: string, results: unknown) => results,
    ),
});

const base = `/api/v2/projects/${PROJECT_UUID}/query`;
const filters = { dimensions: [], metrics: [], tableCalculations: [] };

describe('query routes carry timeRange and audit', () => {
    it('SQL runner / Investigate queries', async () => {
        const service = fakeAsyncQueryService();
        const { call } = buildRouteApp({}, { getAsyncQueryService: service });
        const response = await call('POST', `${base}/sql`, {
            sql: "SELECT * FROM platform_query('select 1')",
            context: 'sqlRunner',
            timeRange: { from: 'now-6h', to: 'now' },
            audit: { description: 'Checking a stuck refill', ticket: 'ENG-123' },
        });
        expect(response.status).toBe(200);
        expect(service.executeAsyncSqlQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                projectUuid: PROJECT_UUID,
                timeRange: { from: 'now-6h', to: 'now' },
                audit: {
                    description: 'Checking a stuck refill',
                    ticket: 'ENG-123',
                },
            }),
        );
    });

    it('dashboard SQL chart tiles', async () => {
        const service = fakeAsyncQueryService();
        const { call } = buildRouteApp({}, { getAsyncQueryService: service });
        const response = await call('POST', `${base}/dashboard-sql-chart`, {
            savedSqlUuid: '00000000-0000-4000-8000-0000000000a1',
            dashboardUuid: '00000000-0000-4000-8000-0000000000a2',
            tileUuid: '00000000-0000-4000-8000-0000000000a3',
            dashboardFilters: filters,
            dashboardSorts: [],
            timeRange: { from: 'now-1h', to: 'now', refreshInterval: '30s' },
        });
        expect(response.status).toBe(200);
        expect(service.executeAsyncDashboardSqlChartQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                timeRange: { from: 'now-1h', to: 'now', refreshInterval: '30s' },
            }),
        );
    });

    it('dashboard chart tiles', async () => {
        const service = fakeAsyncQueryService();
        const { call } = buildRouteApp({}, { getAsyncQueryService: service });
        const response = await call('POST', `${base}/dashboard-chart`, {
            chartUuid: '00000000-0000-4000-8000-0000000000b1',
            dashboardUuid: '00000000-0000-4000-8000-0000000000b2',
            tileUuid: '00000000-0000-4000-8000-0000000000b3',
            dashboardFilters: filters,
            dashboardSorts: [],
            timeRange: {
                from: '2026-11-01T00:00:00.000Z',
                to: '2026-11-02T00:00:00.000Z',
                refreshInterval: null,
            },
        });
        expect(response.status).toBe(200);
        expect(service.executeAsyncDashboardChartQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                timeRange: {
                    from: '2026-11-01T00:00:00.000Z',
                    to: '2026-11-02T00:00:00.000Z',
                    refreshInterval: null,
                },
            }),
        );
    });
});
