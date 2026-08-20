import {
    ChartKind,
    ChartType,
    ResourceViewItemType,
    type ResourceViewChartItem,
    type ResourceViewDashboardItem,
} from '@lightdash/common';
import { Menu } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import { ManageResourceAccessMenuItem } from './ManageResourceAccessMenuItem';
import { type ManageableAccessItem } from './manageResourceAccessTarget';
import { ResourceViewItemAction } from './types';

/**
 * This item is the whole entry point to the grants surface, so what it must get
 * right is when *not* to appear. Direct grants are behind an instance switch, and
 * while that switch is off content permission checks skip the grant lookup
 * entirely -- a grant made here would change nobody's access.
 */

const health = { data: { resourceGrants: { enabled: true } } };

vi.mock('../../../providers/App/useApp', () => ({
    default: () => ({ health }),
}));

const onAction = vi.fn();

const dashboard = (
    overrides: Partial<ResourceViewDashboardItem['data']> = {},
): ResourceViewDashboardItem => ({
    type: ResourceViewItemType.DASHBOARD,
    data: {
        uuid: 'dashboard-1',
        name: 'Q3 Revenue',
        description: undefined,
        views: 0,
        firstViewedAt: null,
        pinnedListUuid: null,
        pinnedListOrder: null,
        spaceUuid: 'space-finance',
        updatedAt: new Date(0),
        updatedByUser: undefined,
        validationErrors: undefined,
        verification: null,
        ...overrides,
    },
});

const chart = (
    overrides: Partial<ResourceViewChartItem['data']> = {},
): ResourceViewChartItem => ({
    type: ResourceViewItemType.CHART,
    data: {
        uuid: 'chart-1',
        name: 'Revenue by month',
        chartType: ChartType.CARTESIAN,
        chartKind: ChartKind.LINE,
        firstViewedAt: null,
        views: 0,
        pinnedListUuid: null,
        pinnedListOrder: null,
        spaceUuid: 'space-finance',
        description: undefined,
        updatedAt: new Date(0),
        updatedByUser: undefined,
        validationErrors: undefined,
        verification: null,
        slug: 'revenue-by-month',
        ...overrides,
    },
});

// Menu.Item needs Menu context, and the dropdown portals into the body -- so
// every query below goes through `screen`, not a container.
const renderMenuItem = (item: ManageableAccessItem): ReactElement => (
    <MantineProvider env="test" forceColorScheme="light">
        <Menu opened>
            <Menu.Dropdown>
                <ManageResourceAccessMenuItem item={item} onAction={onAction} />
            </Menu.Dropdown>
        </Menu>
    </MantineProvider>
);

beforeEach(() => {
    vi.clearAllMocks();
    health.data = { resourceGrants: { enabled: true } };
});

describe('given an instance with direct grants enabled', () => {
    describe('when the menu for a dashboard is open', () => {
        it('then managing access is offered', () => {
            render(renderMenuItem(dashboard()));

            expect(
                screen.getByRole('menuitem', { name: 'Manage access' }),
            ).toBeTruthy();
        });

        it('then it is not called "Share", because nothing here shares yet', () => {
            // Asserted positively over the offered item rather than as an
            // absent string: this surface reads and removes grants, and adding
            // one is a later change. Calling it Share would promise the part
            // that is missing.
            render(renderMenuItem(dashboard()));

            expect(screen.getByRole('menuitem').textContent).toBe(
                'Manage access',
            );
        });
    });
});

describe('given an instance with direct grants disabled', () => {
    describe('when the menu for a dashboard is open', () => {
        it('then managing access is not offered at all', () => {
            health.data = { resourceGrants: { enabled: false } };

            render(renderMenuItem(dashboard()));

            expect(screen.queryByRole('menuitem')).toBeNull();
        });
    });
});

describe('given an instance whose health has not arrived', () => {
    describe('when the menu for a dashboard is open', () => {
        it('then managing access is not offered', () => {
            // Fail closed. Offering it and discovering the gate later would
            // put a control in front of someone that cannot do anything.
            health.data = undefined as unknown as typeof health.data;

            render(renderMenuItem(dashboard()));

            expect(screen.queryByRole('menuitem')).toBeNull();
        });
    });
});

describe('given a dashboard in a content list', () => {
    describe('when managing its access is chosen', () => {
        it('then the manage-access action is raised for that dashboard', async () => {
            const item = dashboard();

            render(renderMenuItem(item));
            await userEvent.click(screen.getByRole('menuitem'));

            expect(onAction).toHaveBeenCalledWith({
                type: ResourceViewItemAction.MANAGE_ACCESS,
                item,
            });
        });
    });
});

describe('given a chart in a content list', () => {
    describe('when managing its access is chosen', () => {
        it('then the manage-access action is raised for that chart', async () => {
            const item = chart();

            render(renderMenuItem(item));
            await userEvent.click(screen.getByRole('menuitem'));

            expect(onAction).toHaveBeenCalledWith({
                type: ResourceViewItemAction.MANAGE_ACCESS,
                item,
            });
        });
    });
});

describe('given an item that reached the menu', () => {
    describe('when managing its access is chosen', () => {
        it('then it is raised as the same object, not one rebuilt here', async () => {
            // Identity rather than equality. The handler acts on `action.item`,
            // so an item reconstructed here is what gets acted on downstream --
            // and a faithful copy would satisfy the two `toHaveBeenCalledWith`
            // assertions above while still being the wrong thing to rely on.
            const item = dashboard();

            render(renderMenuItem(item));
            await userEvent.click(screen.getByRole('menuitem'));

            expect(onAction.mock.calls[0]?.[0].item).toBe(item);
        });
    });
});
