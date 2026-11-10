/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Rendering and interaction helpers for the alerting frontend acceptance tests.
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

/** Renders inside <MantineProvider env="test" forceColorScheme="light"> only. */
export const renderUi = (ui: ReactElement) => {
    const user = userEvent.setup();
    const utils = render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    );
    return { user, ...utils };
};

/** The form control (input/textarea/select) labelled `label`. */
export const field = (label: string | RegExp) => {
    const candidates = screen.getAllByLabelText(label);
    const control = candidates.find((el) =>
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName),
    );
    if (!control) throw new Error(`No form control labelled ${String(label)}`);
    return control as HTMLInputElement;
};

/** Picks `option` in the Mantine Select (or combobox) labelled `label`. */
export const pick = async (
    user: ReturnType<typeof userEvent.setup>,
    label: string | RegExp,
    option: string | RegExp,
) => {
    await user.click(field(label));
    await user.click(await screen.findByRole('option', { name: option }));
};

/** Replaces the value of the text control labelled `label`. */
export const typeInto = async (
    user: ReturnType<typeof userEvent.setup>,
    label: string | RegExp,
    value: string,
) => {
    const el = field(label);
    await user.clear(el);
    if (value)
        await user.type(
            el,
            value.replace(/[{[]/g, (c) => c + c),
        );
};

/**
 * Loads an app module at test time. The path is opaque to Vite's import
 * analysis, so a module that doesn't exist yet fails only the tests that use
 * it, not the whole file. Paths are relative to this folder.
 */
export const load = (modulePath: string): Promise<any> =>
    import(/* @vite-ignore */ modulePath);
