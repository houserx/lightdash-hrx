import {
    assertUnreachable,
    ResourceViewItemType,
    type ResourceAccessResourceType,
    type ResourceViewChartItem,
    type ResourceViewDashboardItem,
} from '@lightdash/common';

/**
 * The items a direct grant can be held on. Spaces are shared through
 * `ShareSpaceModal` instead -- their access is the aggregate, not the atom.
 */
export type ManageableAccessItem =
    | ResourceViewChartItem
    | ResourceViewDashboardItem;

export type ResourceAccessTarget = {
    resourceType: ResourceAccessResourceType;
    /** The resource's own uuid. Never its space's. */
    resourceUuid: string;
    /** Carried separately, and only to look the space's name up for display. */
    spaceUuid: string;
};

/**
 * Kept apart from the components that use it because the interesting mistakes
 * here are invisible to tsc: every field is a string, so crossing two of them
 * compiles cleanly.
 */
export const toResourceAccessTarget = (
    item: ManageableAccessItem,
): ResourceAccessTarget => {
    switch (item.type) {
        case ResourceViewItemType.CHART:
            return {
                resourceType: 'SavedChart',
                resourceUuid: item.data.uuid,
                spaceUuid: item.data.spaceUuid,
            };
        case ResourceViewItemType.DASHBOARD:
            return {
                resourceType: 'Dashboard',
                resourceUuid: item.data.uuid,
                spaceUuid: item.data.spaceUuid,
            };
        default:
            return assertUnreachable(
                item,
                'Resource type cannot hold direct grants',
            );
    }
};
