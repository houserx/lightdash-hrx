import { renderFilterRuleSql } from '../compiler/filtersCompiler';
import { DashboardTileTypes } from '../types/dashboard';
import { type DashboardTimeRange } from '../types/dashboardTimeRange';
import { SupportedDbtAdapter } from '../types/dbt';
import { DimensionType } from '../types/field';
import {
    getDashboardTimeRangeFilterId,
    getDashboardTimeRangeFilterRules,
    isTileAffectedByTimeRange,
    usesReservedTimeParameters,
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

describe('isTileAffectedByTimeRange', () => {
    const chart = { uuid: 'tile-orders', type: DashboardTileTypes.SAVED_CHART };
    const sqlTile = { uuid: 'tile-sql', type: DashboardTileTypes.SQL_CHART };
    const markdown = { uuid: 'tile-note', type: DashboardTileTypes.MARKDOWN };

    it('marks the mapped chart and the SQL tile using __from, not the markdown tile', () => {
        expect(isTileAffectedByTimeRange({ timeRange, tile: chart })).toBe(
            true,
        );
        expect(
            isTileAffectedByTimeRange({
                timeRange,
                tile: sqlTile,
                sql: "SELECT * FROM promql('up', ${ld.parameters.__from}, now(), '30s')",
            }),
        ).toBe(true);
        expect(isTileAffectedByTimeRange({ timeRange, tile: markdown })).toBe(
            false,
        );
    });

    it('marks no tile when the dashboard has no time range', () => {
        expect(
            isTileAffectedByTimeRange({ timeRange: null, tile: chart }),
        ).toBe(false);
        expect(
            isTileAffectedByTimeRange({
                timeRange: undefined,
                tile: sqlTile,
                sql: 'SELECT ${ld.parameters.__to}',
            }),
        ).toBe(false);
    });
});

describe('usesReservedTimeParameters', () => {
    it('detects each reserved time parameter in both prefixes and in Liquid', () => {
        ['__from', '__to', '__interval', '__range'].forEach((name) => {
            expect(
                usesReservedTimeParameters(`SELECT \${ld.parameters.${name}}`),
            ).toBe(true);
            expect(
                usesReservedTimeParameters(
                    `SELECT \${lightdash.parameters.${name}}`,
                ),
            ).toBe(true);
        });
        expect(
            usesReservedTimeParameters(
                "{% if ld.parameters.__range == '6h' %}SELECT 1{% endif %}",
            ),
        ).toBe(true);
    });

    it('ignores other parameters, look-alike names and missing SQL', () => {
        expect(
            usesReservedTimeParameters('SELECT ${ld.parameters.date_zoom}'),
        ).toBe(false);
        expect(
            usesReservedTimeParameters('SELECT ${ld.parameters.__fromage}'),
        ).toBe(false);
        expect(usesReservedTimeParameters("SELECT '__from'")).toBe(false);
        expect(usesReservedTimeParameters(undefined)).toBe(false);
    });
});
