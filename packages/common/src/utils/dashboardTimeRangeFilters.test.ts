import { renderFilterRuleSql } from '../compiler/filtersCompiler';
import { type DashboardTimeRange } from '../types/dashboardTimeRange';
import { SupportedDbtAdapter } from '../types/dbt';
import { DimensionType } from '../types/field';
import {
    getDashboardTimeRangeFilterId,
    getDashboardTimeRangeFilterRules,
} from './dashboardTimeRangeFilters';
import { getDashboardFiltersForTile } from './filters';

const now = new Date('2026-11-08T10:37:43.512Z');

const timeRange: DashboardTimeRange = {
    from: 'now-6h',
    to: 'now',
    refreshInterval: '1m',
    tileTimeDimensions: {
        'tile-orders': { fieldId: 'orders_created_at', tableName: 'orders' },
        'tile-fills': { fieldId: 'fills_filled_at', tableName: 'fills' },
        'tile-deleted': { fieldId: 'old_at', tableName: 'old' },
    },
};

const tileUuids = ['tile-orders', 'tile-fills', 'tile-markdown'];

const getRules = (range: DashboardTimeRange | null = timeRange) =>
    getDashboardTimeRangeFilterRules({ timeRange: range, tileUuids, now });

describe('getDashboardTimeRangeFilterRules', () => {
    it('gives each mapped tile one rule on its own time dimension only', () => {
        const filters = {
            dimensions: getRules(),
            metrics: [],
            tableCalculations: [],
        };

        const orders = getDashboardFiltersForTile('tile-orders', filters);
        expect(orders.dimensions).toHaveLength(1);
        expect(orders.dimensions[0]).toMatchObject({
            id: getDashboardTimeRangeFilterId('tile-orders'),
            target: { fieldId: 'orders_created_at', tableName: 'orders' },
            operator: 'inBetween',
            values: ['2026-11-08T04:37:00.000Z', '2026-11-08T10:37:00.000Z'],
        });

        const fills = getDashboardFiltersForTile('tile-fills', filters);
        expect(fills.dimensions.map((rule) => rule.target.fieldId)).toEqual([
            'fills_filled_at',
        ]);

        expect(
            getDashboardFiltersForTile('tile-markdown', filters).dimensions,
        ).toEqual([]);
    });

    it('ignores mappings for tiles no longer on the dashboard', () => {
        expect(getRules().map((rule) => rule.target.tableName)).toEqual([
            'orders',
            'fills',
        ]);
    });

    it('keeps the same ids and values within one refresh bucket', () => {
        const later = getDashboardTimeRangeFilterRules({
            timeRange,
            tileUuids,
            now: new Date('2026-11-08T10:37:59.000Z'),
        });
        expect(later).toEqual(getRules());
    });

    it('rounds to 10s when refresh is off and keeps absolute bounds', () => {
        const [offRule] = getRules({ ...timeRange, refreshInterval: null });
        expect(offRule.values).toEqual([
            '2026-11-08T04:37:40.000Z',
            '2026-11-08T10:37:40.000Z',
        ]);

        const [absoluteRule] = getRules({
            ...timeRange,
            from: '2026-11-01T00:00:00.123+02:00',
            to: '2026-11-02T00:00:00Z',
        });
        expect(absoluteRule.values).toEqual([
            '2026-10-31T22:00:00.123Z',
            '2026-11-02T00:00:00.000Z',
        ]);
    });

    it('returns no rules without a range or without mappings', () => {
        expect(getRules(null)).toEqual([]);
        expect(getRules({ ...timeRange, tileTimeDimensions: {} })).toEqual([]);
    });

    it('compiles to a bounded timestamp filter', () => {
        const [rule] = getRules();
        const sql = renderFilterRuleSql(
            rule,
            DimensionType.TIMESTAMP,
            '"orders".created_at',
            "'",
            (value) => value,
            null,
            SupportedDbtAdapter.POSTGRES,
        );
        expect(sql).toContain('>=');
        expect(sql).toContain('<=');
        expect(sql).toContain('2026-11-08');
        expect(sql).toContain('04:37:00');
        expect(sql).toContain('10:37:00');
    });
});
