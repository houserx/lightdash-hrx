import { fc, test } from '@fast-check/vitest';
import {
    ChartKind,
    ChartType,
    ResourceViewItemType,
    type ResourceViewChartItem,
    type ResourceViewDashboardItem,
} from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { toResourceAccessTarget } from './manageResourceAccessTarget';

/**
 * A three-field pure mapping gets its own specs because every field in it is a
 * string and nothing here is checkable by tsc. `resourceUuid: item.data.spaceUuid`
 * typechecks. So does routing a chart to `'Dashboard'`. Either one produces a
 * well-formed request about the wrong thing -- a 404, or worse, somebody else's
 * access list -- and the compiler is silent.
 *
 * This is the uuid-vs-slug trap from CLAUDE.md one level along: the danger is not
 * a malformed value, it is a well-formed value of the wrong kind.
 */

// Drawn from disjoint pools so `resourceUuid !== spaceUuid` is a real assertion
// rather than two arbitraries happening to disagree.
const RESOURCE_UUIDS = ['resource-1', 'resource-2', 'resource-3'];
const SPACE_UUIDS = ['space-1', 'space-2', 'space-3'];

const chartItem = (
    overrides: Partial<ResourceViewChartItem['data']> = {},
): ResourceViewChartItem => ({
    type: ResourceViewItemType.CHART,
    data: {
        uuid: 'resource-1',
        name: 'Revenue by month',
        chartType: ChartType.CARTESIAN,
        chartKind: ChartKind.LINE,
        firstViewedAt: null,
        views: 0,
        pinnedListUuid: null,
        pinnedListOrder: null,
        spaceUuid: 'space-1',
        description: undefined,
        updatedAt: new Date(0),
        updatedByUser: undefined,
        validationErrors: undefined,
        verification: null,
        slug: 'revenue-by-month',
        ...overrides,
    },
});

const dashboardItem = (
    overrides: Partial<ResourceViewDashboardItem['data']> = {},
): ResourceViewDashboardItem => ({
    type: ResourceViewItemType.DASHBOARD,
    data: {
        uuid: 'resource-1',
        name: 'Q3 Revenue',
        description: undefined,
        views: 0,
        firstViewedAt: null,
        pinnedListUuid: null,
        pinnedListOrder: null,
        spaceUuid: 'space-1',
        updatedAt: new Date(0),
        updatedByUser: undefined,
        validationErrors: undefined,
        verification: null,
        ...overrides,
    },
});

const identityArb = fc.record({
    uuid: fc.constantFrom(...RESOURCE_UUIDS),
    spaceUuid: fc.constantFrom(...SPACE_UUIDS),
});

/** Everything the mapping has no business reading. */
const incidentalArb = fc.record({
    name: fc.string(),
    views: fc.nat(),
    pinnedListUuid: fc.option(fc.string(), { nil: null }),
    pinnedListOrder: fc.option(fc.nat(), { nil: null }),
});

const itemArb = fc.oneof(
    identityArb.map(chartItem),
    identityArb.map(dashboardItem),
);

describe('given a chart whose access is about to be managed', () => {
    describe('when its access target is derived', () => {
        it('then it names the SavedChart type and the chart itself', () => {
            // 'SavedChart', not 'Chart': the wire vocabulary is the backend's
            // subject name, not the ResourceView item type.
            expect(
                toResourceAccessTarget(
                    chartItem({ uuid: 'resource-2', spaceUuid: 'space-3' }),
                ),
            ).toEqual({
                resourceType: 'SavedChart',
                resourceUuid: 'resource-2',
                spaceUuid: 'space-3',
            });
        });
    });
});

describe('given a dashboard whose access is about to be managed', () => {
    describe('when its access target is derived', () => {
        it('then it names the Dashboard type and the dashboard itself', () => {
            expect(
                toResourceAccessTarget(
                    dashboardItem({ uuid: 'resource-3', spaceUuid: 'space-1' }),
                ),
            ).toEqual({
                resourceType: 'Dashboard',
                resourceUuid: 'resource-3',
                spaceUuid: 'space-1',
            });
        });
    });
});

describe('given any chart or dashboard', () => {
    test.prop([itemArb])(
        'then the target names the resource itself, never its space',
        (item) => {
            const target = toResourceAccessTarget(item);

            expect(target.resourceUuid).toBe(item.data.uuid);
            expect(target.spaceUuid).toBe(item.data.spaceUuid);
            // Stated as well as implied: the pools are disjoint, so a swap
            // fails here even if one of the equalities above were relaxed.
            expect(target.resourceUuid).not.toBe(item.data.spaceUuid);
        },
    );

    test.prop([itemArb])(
        'then the resource type follows the item type and nothing else',
        (item) => {
            expect(toResourceAccessTarget(item).resourceType).toBe(
                item.type === ResourceViewItemType.CHART
                    ? 'SavedChart'
                    : 'Dashboard',
            );
        },
    );

    test.prop([identityArb, incidentalArb, incidentalArb])(
        'then nothing outside the two identity fields moves the answer',
        (identity, incidental, otherIncidental) => {
            // The analogue of the property that made item I's join honest:
            // vary everything a future refactor might start keying off, and
            // require the answer to stay put.
            expect(
                toResourceAccessTarget(
                    chartItem({ ...identity, ...incidental }),
                ),
            ).toEqual(
                toResourceAccessTarget(
                    chartItem({ ...identity, ...otherIncidental }),
                ),
            );

            expect(
                toResourceAccessTarget(
                    dashboardItem({ ...identity, ...incidental }),
                ),
            ).toEqual(
                toResourceAccessTarget(
                    dashboardItem({ ...identity, ...otherIncidental }),
                ),
            );
        },
    );
});
