import {
    type ResourceViewChartItem,
    type ResourceViewDashboardItem,
    type ResourceViewDataAppItem,
    type ResourceViewItem,
    type ResourceViewSpaceItem,
} from '@lightdash/common';
import { type ReactNode } from 'react';
import { type ManageableAccessItem } from './manageResourceAccessTarget';

export enum ResourceViewItemAction {
    CLOSE,
    UPDATE,
    DELETE,
    DUPLICATE,
    ADD_TO_DASHBOARD,
    CREATE_SPACE,
    PIN_TO_HOMEPAGE,
    TRANSFER_TO_SPACE,
    SHARE,
    MANAGE_ACCESS,
}

export enum ResourceViewType {
    LIST = 'list',
    GRID = 'grid',
}

export enum ResourceSortDirection {
    ASC = 'asc',
    DESC = 'desc',
}

export type ResourceViewItemActionState =
    | {
          type: ResourceViewItemAction.CLOSE;
      }
    | {
          type: ResourceViewItemAction.UPDATE;
          item: ResourceViewItem;
      }
    | {
          type: ResourceViewItemAction.DELETE;
          item: ResourceViewItem;
      }
    | {
          type: ResourceViewItemAction.DUPLICATE;
          item: ResourceViewChartItem | ResourceViewDashboardItem;
      }
    | {
          type: ResourceViewItemAction.ADD_TO_DASHBOARD;
          item: ResourceViewChartItem;
      }
    | {
          type: ResourceViewItemAction.CREATE_SPACE;
          item: ResourceViewChartItem | ResourceViewDashboardItem;
      }
    | {
          type: ResourceViewItemAction.PIN_TO_HOMEPAGE;
          item: ResourceViewItem;
      }
    | {
          type: ResourceViewItemAction.TRANSFER_TO_SPACE;
          item:
              | ResourceViewChartItem
              | ResourceViewDashboardItem
              | ResourceViewSpaceItem
              | ResourceViewDataAppItem;
      }
    | {
          type: ResourceViewItemAction.SHARE;
          item: ResourceViewSpaceItem;
      }
    /**
     * Its own action rather than a widened SHARE. Widening SHARE's item would
     * compile unchanged -- every view item has a `uuid`, and SHARE's handler
     * feeds that uuid to `useSpace` -- so a dashboard would have been looked up
     * as a space and the menu entry would have quietly done nothing. A separate
     * member makes the handler's `assertUnreachable` catch it instead.
     */
    | {
          type: ResourceViewItemAction.MANAGE_ACCESS;
          item: ManageableAccessItem;
      };

type TabType = {
    id: string;
    name?: string;
    icon?: ReactNode;
    infoTooltipText?: string;
    sort?: (a: ResourceViewItem, b: ResourceViewItem) => number;
    filter?: (item: ResourceViewItem, index: number) => boolean;
    emptyStateProps?: ResourceEmptyStateProps;
    hasReorder?: boolean;
};

interface ResourceHeaderProps {
    title?: string;
    description?: string;
    action?: React.ReactNode;
}

export interface ResourceViewCommonProps {
    items: ResourceViewItem[];
    tabs?: TabType[];
    maxItems?: number;
    headerProps?: ResourceHeaderProps;
    emptyStateProps?: ResourceEmptyStateProps;
    view?: ResourceViewType;
    hasReorder?: boolean;
}

export interface ResourceEmptyStateProps {
    icon?: ReactNode;
    title?: string;
    description?: string;
    action?: ReactNode;
}

export enum ColumnVisibility {
    NAME = 'name',
    SPACE = 'space',
    UPDATED_AT = 'updatedAt',
    VIEWS = 'views',
    ACCESS = 'access',
    CONTENT = 'content',
}

export type ColumnVisibilityConfig = {
    [ColumnVisibility.NAME]?: boolean;
    [ColumnVisibility.SPACE]?: boolean;
    [ColumnVisibility.UPDATED_AT]?: boolean;
    [ColumnVisibility.VIEWS]?: boolean;
    [ColumnVisibility.ACCESS]?: boolean;
    [ColumnVisibility.CONTENT]?: boolean;
};

export enum ResourceAccess {
    Private = 'private',
    Public = 'public',
    Shared = 'shared',
}
