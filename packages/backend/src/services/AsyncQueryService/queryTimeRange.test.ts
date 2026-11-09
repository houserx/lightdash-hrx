import {
    FilterOperator,
    ParameterError,
    type DashboardFilters,
    type DashboardTimeRange,
} from '@lightdash/common';
import {
    normalizeQueryAudit,
    savedSqlChartAudit,
    withTimeRangeParameters,
    withTimeRangeTileFilter,
} from './queryTimeRange';

const now = new Date('2026-11-08T12:34:56.789Z');

const noFilters: DashboardFilters = {
    dimensions: [],
    metrics: [],
    tableCalculations: [],
};

const savedTimeRange: DashboardTimeRange = {
    from: 'now-24h',
    to: 'now',
    refreshInterval: null,
    tileTimeDimensions: {
        'tile-mapped': { fieldId: 'orders_shipped_at', tableName: 'orders' },
    },
};

describe('withTimeRangeParameters', () => {
    it('resolves the reserved time parameters, rounded to the refresh interval', () => {
        expect(
            withTimeRangeParameters(
                { region: 'east' },
                { from: 'now-6h', to: 'now', refreshInterval: '1m' },
                now,
            ),
        ).toEqual({
            region: 'east',
            __from: '2026-11-08T06:34:00.000Z',
            __to: '2026-11-08T12:34:00.000Z',
            __interval: '30s',
            __range: '6h',
        });
    });

    it('rounds to 10s without a refresh interval and passes absolute ranges through', () => {
        expect(
            withTimeRangeParameters(
                undefined,
                { from: 'now-1h', to: 'now' },
                now,
            ),
        ).toMatchObject({
            __from: '2026-11-08T11:34:50.000Z',
            __to: '2026-11-08T12:34:50.000Z',
        });
        expect(
            withTimeRangeParameters(
                {},
                {
                    from: '2026-11-01T00:00:00.000Z',
                    to: '2026-11-02T00:00:00.000Z',
                    refreshInterval: null,
                },
                now,
            ),
        ).toMatchObject({
            __from: '2026-11-01T00:00:00.000Z',
            __to: '2026-11-02T00:00:00.000Z',
            __range: '1d',
        });
    });

    it('lets a same-named user parameter win', () => {
        expect(
            withTimeRangeParameters(
                { __from: 'user value' },
                { from: 'now-6h', to: 'now' },
                now,
            ),
        ).toMatchObject({ __from: 'user value', __to: expect.any(String) });
    });

    it('leaves parameters unchanged without a time range', () => {
        const parameters = { region: 'east' };
        expect(withTimeRangeParameters(parameters, undefined, now)).toBe(
            parameters,
        );
        expect(withTimeRangeParameters(undefined, undefined, now)).toBe(
            undefined,
        );
    });

    it('refuses invalid ranges', () => {
        expect(() =>
            withTimeRangeParameters({}, { from: 'yesterday', to: 'now' }, now),
        ).toThrow(ParameterError);
        expect(() =>
            withTimeRangeParameters({}, { from: 'now', to: 'now-1h' }, now),
        ).toThrow(ParameterError);
        expect(() =>
            withTimeRangeParameters(
                {},
                {
                    from: 'now-1h',
                    to: 'now',
                    refreshInterval: '2m' as never,
                },
                now,
            ),
        ).toThrow(ParameterError);
    });
});

describe('withTimeRangeTileFilter', () => {
    it('adds an inBetween rule on the mapped tile time dimension', () => {
        const filters = withTimeRangeTileFilter({
            dashboardFilters: noFilters,
            timeRange: { from: 'now-6h', to: 'now', refreshInterval: '5m' },
            savedTimeRange,
            tileUuid: 'tile-mapped',
            now,
        });
        expect(filters.dimensions).toEqual([
            {
                id: 'dashboard-time-range:tile-mapped',
                label: undefined,
                target: { fieldId: 'orders_shipped_at', tableName: 'orders' },
                operator: FilterOperator.IN_BETWEEN,
                values: [
                    '2026-11-08T06:30:00.000Z',
                    '2026-11-08T12:30:00.000Z',
                ],
                tileTargets: {
                    'tile-mapped': {
                        fieldId: 'orders_shipped_at',
                        tableName: 'orders',
                    },
                },
            },
        ]);
        expect(filters.metrics).toEqual([]);
    });

    it('keeps existing filters and replaces a previous time range rule', () => {
        const existing = {
            id: 'status',
            label: undefined,
            target: { fieldId: 'orders_status', tableName: 'orders' },
            operator: FilterOperator.EQUALS,
            values: ['shipped'],
        };
        const stale = {
            id: 'dashboard-time-range:tile-mapped',
            label: undefined,
            target: { fieldId: 'orders_shipped_at', tableName: 'orders' },
            operator: FilterOperator.IN_BETWEEN,
            values: ['2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z'],
        };
        const filters = withTimeRangeTileFilter({
            dashboardFilters: {
                ...noFilters,
                dimensions: [existing, stale],
            },
            timeRange: { from: 'now-1h', to: 'now' },
            savedTimeRange,
            tileUuid: 'tile-mapped',
            now,
        });
        expect(filters.dimensions.map((rule) => rule.id)).toEqual([
            'status',
            'dashboard-time-range:tile-mapped',
        ]);
        expect(filters.dimensions[1].values).toEqual([
            '2026-11-08T11:34:50.000Z',
            '2026-11-08T12:34:50.000Z',
        ]);
    });

    it('leaves unmapped tiles, dashboards without a range and requests without a range unchanged', () => {
        const timeRange = { from: 'now-6h', to: 'now' };
        expect(
            withTimeRangeTileFilter({
                dashboardFilters: noFilters,
                timeRange,
                savedTimeRange,
                tileUuid: 'tile-other',
                now,
            }),
        ).toBe(noFilters);
        expect(
            withTimeRangeTileFilter({
                dashboardFilters: noFilters,
                timeRange,
                savedTimeRange: null,
                tileUuid: 'tile-mapped',
                now,
            }),
        ).toBe(noFilters);
        expect(
            withTimeRangeTileFilter({
                dashboardFilters: noFilters,
                timeRange: undefined,
                savedTimeRange,
                tileUuid: 'tile-mapped',
                now,
            }),
        ).toBe(noFilters);
    });

    it('refuses an invalid range', () => {
        expect(() =>
            withTimeRangeTileFilter({
                dashboardFilters: noFilters,
                timeRange: { from: 'now-6h', to: 'later' },
                savedTimeRange,
                tileUuid: 'tile-other',
                now,
            }),
        ).toThrow(ParameterError);
    });
});

describe('normalizeQueryAudit', () => {
    it('trims the description and ticket', () => {
        expect(
            normalizeQueryAudit({
                description: '  Checking a stuck refill ',
                ticket: ' ENG-123 ',
            }),
        ).toEqual({
            description: 'Checking a stuck refill',
            ticket: 'ENG-123',
        });
    });

    it('makes a missing or blank ticket null', () => {
        expect(normalizeQueryAudit({ description: 'why' })).toEqual({
            description: 'why',
            ticket: null,
        });
        expect(
            normalizeQueryAudit({ description: 'why', ticket: ' ' }),
        ).toEqual({ description: 'why', ticket: null });
    });

    it('refuses a blank description', () => {
        expect(() => normalizeQueryAudit({ description: '   ' })).toThrow(
            'An Audited Query needs a description',
        );
    });

    it('passes no audit through', () => {
        expect(normalizeQueryAudit(undefined)).toBeUndefined();
    });
});

describe('savedSqlChartAudit', () => {
    it("uses the saved chart's trimmed description, with no ticket", () => {
        expect(savedSqlChartAudit('  Open fills per queue ')).toEqual({
            description: 'Open fills per queue',
            ticket: null,
        });
    });

    it('sends no audit for a chart without a description', () => {
        expect(savedSqlChartAudit(null)).toBeUndefined();
        expect(savedSqlChartAudit(undefined)).toBeUndefined();
        expect(savedSqlChartAudit('   ')).toBeUndefined();
    });
});
