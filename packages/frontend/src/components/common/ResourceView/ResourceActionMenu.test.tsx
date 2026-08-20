import {
    ResourceViewItemType,
    type ResourceViewDashboardItem,
    type ResourceViewSpaceItem,
} from '@lightdash/common';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import ResourceViewActionMenu from './ResourceActionMenu';
import { ResourceViewItemAction } from './types';

/**
 * One spec, for the one thing none of the others can see: that the menu item is
 * actually in the menu.
 *
 * ManageResourceAccessMenuItem has its own specs, and the handler branch is a
 * compile error until it exists -- but the line that puts the item in the
 * dropdown is invisible to both. Delete it and every other spec in this PR still
 * passes while the feature becomes unreachable. That is the same hole that had
 * to be closed on the modal's footer, so it gets a guard this time rather than a
 * second discovery.
 *
 * The mock surface below is the price of this component having fifteen hooks. It
 * is all stubs; nothing here asserts on anything but the presence of one item.
 */

const noopMutation = { mutate: vi.fn(), reset: vi.fn(), isLoading: false };

vi.mock('react-router', () => ({
    useLocation: () => ({ pathname: '/projects/project-1/dashboards' }),
    useNavigate: () => vi.fn(),
    useParams: () => ({ projectUuid: 'project-1' }),
}));

vi.mock('../../../providers/App/useApp', () => ({
    default: () => ({
        user: {
            data: {
                organizationUuid: 'org-1',
                // Stubbed wide open: which abilities gate this item is
                // ResourceActionMenu's existing concern, not this spec's.
                ability: { can: () => true },
            },
        },
        health: { data: { resourceGrants: { enabled: true } } },
    }),
}));

vi.mock('../../../providers/Favorites/useFavoritesContext', () => ({
    default: () => undefined,
}));

vi.mock('../../../hooks/useProject', () => ({
    useProject: () => ({ data: { upstreamProjectUuid: undefined } }),
}));

vi.mock('../../../hooks/useSpaces', () => ({
    useSpaceSummaries: () => ({ data: [] }),
}));

vi.mock('../../../hooks/useContentVerification', () => ({
    useVerifyChartMutation: () => noopMutation,
    useUnverifyChartMutation: () => noopMutation,
    useVerifyDashboardMutation: () => noopMutation,
    useUnverifyDashboardMutation: () => noopMutation,
}));

vi.mock('../../../features/promotion/hooks/usePromoteChart', () => ({
    usePromoteMutation: () => noopMutation,
    usePromoteChartDiffMutation: () => noopMutation,
}));

vi.mock('../../../features/promotion/hooks/usePromoteDashboard', () => ({
    usePromoteDashboardMutation: () => noopMutation,
    usePromoteDashboardDiffMutation: () => noopMutation,
}));

vi.mock('../../../features/apps/hooks/useDuplicateApp', () => ({
    useDuplicateApp: () => noopMutation,
}));

vi.mock(
    '../../../features/promotion/components/PromotionConfirmDialog',
    () => ({
        PromotionConfirmDialog: () => null,
    }),
);

vi.mock('../../../features/apps/components/PromoteAppModal', () => ({
    PromoteAppModal: () => null,
}));

vi.mock(
    '../../../features/apps/components/FavoritePersonalDataAppModal',
    () => ({ FavoritePersonalDataAppModal: () => null }),
);

vi.mock(
    '../../../ee/features/aiCopilot/components/AskAiAgentMenuItem/AskAiAgentMenuItem',
    () => ({ AskAiAgentMenuItem: () => null }),
);

const dashboardItem: ResourceViewDashboardItem = {
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
    },
};

const spaceItem = {
    type: ResourceViewItemType.SPACE,
    data: {
        uuid: 'space-finance',
        name: 'Finance',
        projectUuid: 'project-1',
        organizationUuid: 'org-1',
        pinnedListUuid: null,
        pinnedListOrder: null,
        parentSpaceUuid: null,
        path: 'finance',
        inheritParentPermissions: false,
        access: [],
        accessListLength: 0,
        dashboardCount: 0,
        chartCount: 0,
        childSpaceCount: 0,
        appCount: 0,
    },
} as unknown as ResourceViewSpaceItem;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('given an open action menu for a dashboard', () => {
    describe('when its actions are listed', () => {
        it('then managing its access is one of them', () => {
            render(
                <MantineProvider env="test" forceColorScheme="light">
                    <ResourceViewActionMenu
                        item={dashboardItem}
                        isOpen
                        onAction={vi.fn()}
                    />
                </MantineProvider>,
            );

            expect(
                screen.getByRole('menuitem', { name: /Manage access/ }),
            ).toBeTruthy();
        });
    });
});

describe('given the manage access item in a real dashboard menu', () => {
    describe('when it is chosen', () => {
        it('then the menu raises the manage-access action for that dashboard', async () => {
            // The closest this suite gets to clicking it: the real menu, the
            // real item, a real click, and the action the handler switches on.
            // Together with ManageResourceAccessAction's specs -- which cover
            // action to modal props -- and the compiler forcing the handler
            // branch to exist, the whole chain is covered bar the browser.
            const onAction = vi.fn();

            render(
                <MantineProvider env="test" forceColorScheme="light">
                    <ResourceViewActionMenu
                        item={dashboardItem}
                        isOpen
                        onAction={onAction}
                    />
                </MantineProvider>,
            );

            await userEvent.click(
                screen.getByRole('menuitem', { name: /Manage access/ }),
            );

            expect(onAction).toHaveBeenCalledWith({
                type: ResourceViewItemAction.MANAGE_ACCESS,
                item: dashboardItem,
            });
        });
    });
});

describe('given an open action menu for a space', () => {
    describe('when its actions are listed', () => {
        it('then it offers Share and not manage access', () => {
            // A space's access is the aggregate of what it holds, so it is
            // shared through ShareSpaceModal. Both assertions matter: without
            // the first, deleting the whole block would satisfy the second.
            render(
                <MantineProvider env="test" forceColorScheme="light">
                    <ResourceViewActionMenu
                        item={spaceItem}
                        isOpen
                        onAction={vi.fn()}
                    />
                </MantineProvider>,
            );

            expect(
                screen.getByRole('menuitem', { name: /Share/ }),
            ).toBeTruthy();
            expect(
                screen.queryByRole('menuitem', { name: /Manage access/ }),
            ).toBeNull();
        });
    });
});
