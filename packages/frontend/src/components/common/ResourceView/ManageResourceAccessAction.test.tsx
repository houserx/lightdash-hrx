import {
    ChartKind,
    ChartType,
    ResourceViewItemType,
    type ResourceViewChartItem,
    type ResourceViewDashboardItem,
    type SpaceSummary,
} from '@lightdash/common';
import { render } from '@testing-library/react';
import { type ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpaceSummaries } from '../../../hooks/useSpaces';
import { type ManageResourceAccessModal } from '../ManageResourceAccessModal/ManageResourceAccessModal';
import { ManageResourceAccessAction } from './ManageResourceAccessAction';

/**
 * The modal is replaced by a prop recorder. Every mistake available here is a
 * wiring mistake that typechecks -- the resource's uuid and its space's are both
 * strings, and so are its name and its space's name -- and the modal itself is
 * behind Mantine's portal anyway.
 */

vi.mock('../../../hooks/useSpaces', () => ({
    useSpaceSummaries: vi.fn(),
}));

type ModalProps = ComponentProps<typeof ManageResourceAccessModal>;

let modalProps: ModalProps | undefined;

vi.mock('../ManageResourceAccessModal/ManageResourceAccessModal', () => ({
    ManageResourceAccessModal: (props: ModalProps) => {
        modalProps = props;
        return null;
    },
}));

const onClose = vi.fn();

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

/** Only the two fields the lookup reads; the rest is what the API returns. */
const spaceSummary = (uuid: string, name: string): SpaceSummary =>
    ({ uuid, name }) as SpaceSummary;

type SpacesQuery = ReturnType<typeof useSpaceSummaries>;

const givenSpaces = (spaces: SpacesQuery['data']) => {
    vi.mocked(useSpaceSummaries).mockReturnValue({
        data: spaces,
    } as unknown as SpacesQuery);
};

beforeEach(() => {
    vi.clearAllMocks();
    modalProps = undefined;
    givenSpaces([spaceSummary('space-finance', 'Finance')]);
});

describe('given a dashboard picked from a content list', () => {
    describe('when its access is managed', () => {
        it('then the modal is opened about that dashboard', () => {
            render(
                <ManageResourceAccessAction
                    item={dashboard()}
                    projectUuid="project-1"
                    onClose={onClose}
                />,
            );

            expect(modalProps?.opened).toBe(true);
            expect(modalProps?.resourceType).toBe('Dashboard');
            expect(modalProps?.resourceUuid).toBe('dashboard-1');
            expect(modalProps?.resourceName).toBe('Q3 Revenue');
            expect(modalProps?.projectUuid).toBe('project-1');
        });

        it('then the space it lives in is named, not its uuid', () => {
            render(
                <ManageResourceAccessAction
                    item={dashboard()}
                    projectUuid="project-1"
                    onClose={onClose}
                />,
            );

            expect(modalProps?.spaceName).toBe('Finance');
        });
    });
});

describe('given a chart picked from a content list', () => {
    describe('when its access is managed', () => {
        it('then the modal is opened about that chart, under the wire name', () => {
            render(
                <ManageResourceAccessAction
                    item={chart()}
                    projectUuid="project-1"
                    onClose={onClose}
                />,
            );

            expect(modalProps?.resourceType).toBe('SavedChart');
            expect(modalProps?.resourceUuid).toBe('chart-1');
            expect(modalProps?.resourceName).toBe('Revenue by month');
        });
    });
});

describe('given the space summaries have not arrived', () => {
    describe('when the modal is opened', () => {
        it('then it opens anyway, with no space named', () => {
            // The name is decoration on one line of copy, so waiting for it
            // would hold the whole surface back for nothing. `null` is the
            // honest value -- the modal words its strip differently without a
            // space name rather than printing a placeholder.
            givenSpaces(undefined);

            render(
                <ManageResourceAccessAction
                    item={dashboard()}
                    projectUuid="project-1"
                    onClose={onClose}
                />,
            );

            expect(modalProps?.opened).toBe(true);
            expect(modalProps?.spaceName).toBeNull();
        });
    });
});

describe('given a resource whose space is not in the summaries', () => {
    describe('when the modal is opened', () => {
        it('then no space is named rather than the wrong one', () => {
            // A private space the requester cannot see still yields a resource
            // they may hold a grant on. Naming the first space in the list here
            // would attribute it to somewhere it does not live.
            givenSpaces([spaceSummary('space-marketing', 'Marketing')]);

            render(
                <ManageResourceAccessAction
                    item={dashboard()}
                    projectUuid="project-1"
                    onClose={onClose}
                />,
            );

            expect(modalProps?.spaceName).toBeNull();
        });
    });
});

describe('given an open modal', () => {
    describe('when it reports that it closed', () => {
        it('then the action is dismissed for its caller', () => {
            render(
                <ManageResourceAccessAction
                    item={dashboard()}
                    projectUuid="project-1"
                    onClose={onClose}
                />,
            );

            modalProps?.onClose();

            expect(onClose).toHaveBeenCalledTimes(1);
        });
    });
});
