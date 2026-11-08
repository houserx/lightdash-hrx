/**
 * Rendering helpers for ldq acceptance tests. Components render inside MantineProvider only
 * (never renderWithProviders): they are presentational and receive their data as props.
 */
import { MantineProvider } from '@mantine/core';
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

export const renderUi = (ui: ReactElement) => ({
    user: userEvent.setup(),
    ...render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    ),
});

/** Picks an option in a native <select> or a Mantine Select/combobox found by its label. */
export const chooseOption = async (label: string | RegExp, option: string) => {
    const element = screen.getByLabelText(label);
    if (element.tagName === 'SELECT') {
        const match = Array.from((element as HTMLSelectElement).options).find(
            (candidate) => candidate.textContent?.trim() === option,
        );
        if (!match) throw new Error(`No option "${option}" in ${String(label)}`);
        fireEvent.change(element, { target: { value: match.value } });
        return;
    }
    fireEvent.click(element);
    const choice = await screen.findByRole('option', { name: option });
    fireEvent.click(choice);
};

/** Lists the option labels of a native <select> or a Mantine Select found by its label. */
export const listOptions = async (label: string | RegExp): Promise<string[]> => {
    const element = screen.getByLabelText(label);
    if (element.tagName === 'SELECT') {
        return Array.from((element as HTMLSelectElement).options).map(
            (option) => option.textContent?.trim() ?? '',
        );
    }
    fireEvent.click(element);
    await screen.findAllByRole('option');
    const options = screen
        .getAllByRole('option')
        .map((option) => option.textContent?.trim() ?? '');
    fireEvent.keyDown(element, { key: 'Escape' });
    return options;
};

/** Sets a text field's value in one step (typing braces is awkward with user-event). */
export const setText = (label: string | RegExp, value: string) => {
    const element = screen.getByLabelText(label);
    fireEvent.change(element, { target: { value } });
    return element;
};

export const textOf = (label: string | RegExp) =>
    (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement)
        .value;

export { fireEvent, screen, waitFor, within };
