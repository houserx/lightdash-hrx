import { Menu } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MantineProvider from '../../../providers/MantineProvider';
import { ManageResourceAccessMenuItem } from './ManageResourceAccessMenuItem';

/**
 * This item is the entry point to the grants surface from every menu that has
 * one, so what it must get right is when *not* to appear. Direct grants sit
 * behind an instance switch, and while that switch is off content permission
 * checks skip the grant lookup entirely -- a grant made here would change
 * nobody's access.
 *
 * It takes a plain `onClick` and knows nothing about what clicking does, because
 * its two callers do entirely different things with it: a content list raises an
 * action for its handler to switch on, and a page header opens the modal itself.
 * What the click *means* is therefore specified at each call site, not here.
 */

const health = { data: { resourceGrants: { enabled: true } } };

vi.mock('../../../providers/App/useApp', () => ({
    default: () => ({ health }),
}));

const onClick = vi.fn();

// Menu.Item needs Menu context, and the dropdown portals into the body -- so
// every query below goes through `screen`, not a container.
const renderMenuItem = (): ReactElement => (
    <MantineProvider env="test" forceColorScheme="light">
        <Menu opened>
            <Menu.Dropdown>
                <ManageResourceAccessMenuItem onClick={onClick} />
            </Menu.Dropdown>
        </Menu>
    </MantineProvider>
);

beforeEach(() => {
    vi.clearAllMocks();
    health.data = { resourceGrants: { enabled: true } };
});

describe('given an instance with direct grants enabled', () => {
    describe('when a menu holding this item is open', () => {
        it('then managing access is offered', () => {
            render(renderMenuItem());

            expect(
                screen.getByRole('menuitem', { name: 'Manage access' }),
            ).toBeTruthy();
        });

        it('then it is not called "Share", because nothing here shares yet', () => {
            // Asserted positively over the offered item rather than as an
            // absent string: this surface reads and removes grants, and adding
            // one is a later change. Calling it Share would promise the part
            // that is missing, and a negative assertion on that word would pass
            // vacuously.
            render(renderMenuItem());

            expect(screen.getByRole('menuitem').textContent).toBe(
                'Manage access',
            );
        });
    });
});

describe('given an instance with direct grants disabled', () => {
    describe('when a menu holding this item is open', () => {
        it('then managing access is not offered at all', () => {
            health.data = { resourceGrants: { enabled: false } };

            render(renderMenuItem());

            expect(screen.queryByRole('menuitem')).toBeNull();
        });
    });
});

describe('given an instance whose health has not arrived', () => {
    describe('when a menu holding this item is open', () => {
        it('then managing access is not offered', () => {
            // Fail closed. Offering it and learning the gate later would put a
            // control in front of someone that cannot do anything.
            health.data = undefined as unknown as typeof health.data;

            render(renderMenuItem());

            expect(screen.queryByRole('menuitem')).toBeNull();
        });
    });
});

describe('given the item is offered', () => {
    describe('when it is chosen', () => {
        it('then the caller is told once, and decides what that means', async () => {
            render(renderMenuItem());

            await userEvent.click(screen.getByRole('menuitem'));

            expect(onClick).toHaveBeenCalledTimes(1);
        });
    });
});
