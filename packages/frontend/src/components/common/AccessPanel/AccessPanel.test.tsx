import { Badge, Text } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import {
    AccessOriginBadge,
    AccessPanel,
    PrincipalAccessRow,
    type AccessPrincipal,
} from './AccessPanel';
import classes from './AccessPanel.module.css';

/** Scoped to the row: the render container also holds Mantine's stylesheet. */
const rowText = (container: HTMLElement) =>
    container.querySelector(`.${classes.row}`)?.textContent;

const renderWithMantine = (ui: ReactElement) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    );

const user: AccessPrincipal = {
    type: 'user',
    userUuid: 'user-ada',
    name: 'Ada Lovelace',
    initials: 'AL',
    avatarUrl: null,
    avatarGradient: null,
    isServiceAccount: false,
    isSessionUser: false,
};

const group: AccessPrincipal = {
    type: 'group',
    groupUuid: 'group-analysts',
    name: 'Analysts',
};

describe('given a badge describing where access came from', () => {
    describe('when the access is inherited', () => {
        it('then it names the source alongside the role', () => {
            renderWithMantine(
                <AccessOriginBadge
                    origin={{
                        inheritedFrom: 'project',
                        hasDirectAccess: false,
                    }}
                    roleLabel="Can view"
                    color="yellow.8"
                />,
            );

            expect(screen.getByText(/Project/)).toBeInTheDocument();
            expect(screen.getByText(/Can view/)).toBeInTheDocument();
        });
    });

    describe('when the access is a grant on the resource itself', () => {
        it('then it is not passed off as a share on the space', () => {
            renderWithMantine(
                <AccessOriginBadge
                    origin={{
                        inheritedFrom: 'direct_resource',
                        hasDirectAccess: true,
                    }}
                    roleLabel="Can edit"
                    color="green.6"
                />,
            );

            expect(screen.getByText(/Granted/)).toBeInTheDocument();
            expect(screen.queryByText(/Direct/)).not.toBeInTheDocument();
        });
    });
});

describe('given a row for one principal', () => {
    const renderRow = (
        props: Partial<ComponentProps<typeof PrincipalAccessRow>> = {},
    ) =>
        renderWithMantine(
            <PrincipalAccessRow
                principal={props.principal ?? user}
                control={props.control ?? <Badge>Can view</Badge>}
                disclosure={props.disclosure}
            />,
        );

    describe('when the principal is a person', () => {
        it('then they are named with the control for their access', () => {
            renderRow();

            expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
            expect(screen.getByText('Can view')).toBeInTheDocument();
        });

        it('then the signed-in person is marked as themselves', () => {
            renderRow({ principal: { ...user, isSessionUser: true } });

            expect(screen.getByText('(you)')).toBeInTheDocument();
        });

        it('then a service account is badged as one', () => {
            renderRow({ principal: { ...user, isServiceAccount: true } });

            expect(screen.getByText('Service account')).toBeInTheDocument();
        });

        it('then a person who is neither is badged as neither', () => {
            renderRow();

            expect(screen.queryByText('(you)')).not.toBeInTheDocument();
            expect(
                screen.queryByText('Service account'),
            ).not.toBeInTheDocument();
        });
    });

    describe('when the principal is a group', () => {
        it('then it is named without any person-specific markings', () => {
            renderRow({ principal: group });

            expect(screen.getByText('Analysts')).toBeInTheDocument();
            expect(screen.queryByText('(you)')).not.toBeInTheDocument();
            expect(
                screen.queryByText('Service account'),
            ).not.toBeInTheDocument();
        });
    });

    describe('when the surface has more to say about the access', () => {
        it('then what it passes is shown under the principal', () => {
            const { container } = renderRow({
                disclosure: <Text>Inherited from the Finance space</Text>,
            });

            expect(rowText(container)).toBe(
                'ALAda LovelaceCan viewInherited from the Finance space',
            );
        });

        it('then a surface with nothing to add stays a single line', () => {
            const { container } = renderRow();

            expect(rowText(container)).toBe('ALAda LovelaceCan view');
        });
    });
});

describe('given a panel listing principals a page at a time', () => {
    const renderPanel = (
        props: Partial<ComponentProps<typeof AccessPanel>> = {},
    ) => {
        const onPageChange = vi.fn<(page: number) => void>();
        renderWithMantine(
            <AccessPanel
                page={props.page ?? 1}
                totalPages={props.totalPages ?? 1}
                onPageChange={props.onPageChange ?? onPageChange}
            >
                {props.children ?? <Text>Ada Lovelace</Text>}
            </AccessPanel>,
        );
        return { onPageChange };
    };

    describe('when everything fits on one page', () => {
        it('then the principals are listed with no page controls', () => {
            renderPanel();

            expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
            expect(screen.queryAllByRole('button')).toHaveLength(0);
        });
    });

    describe('when there is more than one page', () => {
        it('then either direction can be taken', () => {
            const { onPageChange } = renderPanel({ page: 2, totalPages: 3 });

            const [previous, next] = screen.getAllByRole('button');

            fireEvent.click(next);
            expect(onPageChange).toHaveBeenCalledWith(3);

            fireEvent.click(previous);
            expect(onPageChange).toHaveBeenCalledWith(1);
        });

        it('then paging back from the first page is refused', () => {
            const { onPageChange } = renderPanel({ page: 1, totalPages: 2 });

            const [previous] = screen.getAllByRole('button');
            expect(previous).toBeDisabled();

            fireEvent.click(previous);
            expect(onPageChange).not.toHaveBeenCalled();
        });

        it('then paging on from the last page is refused', () => {
            const { onPageChange } = renderPanel({ page: 2, totalPages: 2 });

            const [, next] = screen.getAllByRole('button');
            expect(next).toBeDisabled();

            fireEvent.click(next);
            expect(onPageChange).not.toHaveBeenCalled();
        });
    });
});
