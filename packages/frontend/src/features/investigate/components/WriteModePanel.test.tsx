import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WriteModePanel, type WriteModeApi } from './WriteModePanel';

const renderPanel = (statement: string, api: WriteModeApi) => {
    const ui = (current: string) => (
        <MantineProvider env="test" forceColorScheme="light">
            <WriteModePanel statement={current} api={api} />
        </MantineProvider>
    );
    const view = render(ui(statement));
    return { rerender: (next: string) => view.rerender(ui(next)) };
};

const confirmation = async () => ({
    confirmationToken: 'confirmation',
    expiresAt: '2026-11-08T10:02:00.000Z',
});

const describeAs = (value: string) =>
    fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value },
    });

describe('WriteModePanel', () => {
    it('shows the message of a Lightdash API error body and sends no blank ticket', async () => {
        const write = vi.fn(async () => {
            throw {
                status: 'error',
                error: { statusCode: 409, message: 'Statement changed' },
            };
        });
        renderPanel('DELETE FROM locks WHERE id = 1', {
            createConfirmation: confirmation,
            write,
        });
        describeAs('Release a lock');
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
        expect(
            await screen.findByText('Statement changed'),
        ).toBeInTheDocument();
        expect(write).toHaveBeenCalledWith(
            expect.not.objectContaining({ ticket: expect.anything() }),
        );
    });

    it('stays disabled with a blank statement and hides a result once the statement changes', async () => {
        const api: WriteModeApi = {
            createConfirmation: confirmation,
            write: async () => ({
                audit_id: 'audit',
                rows_affected: 0,
                preview: true,
                returning: null,
            }),
        };
        const { rerender } = renderPanel('  ', api);
        describeAs('Release a lock');
        expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();

        rerender('DELETE FROM locks WHERE id = 1');
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
        expect(
            await screen.findByTestId('write-mode-result'),
        ).toHaveTextContent('Rows affected: 0');

        rerender('DELETE FROM locks WHERE id = 2');
        await waitFor(() =>
            expect(
                screen.queryByTestId('write-mode-result'),
            ).not.toBeInTheDocument(),
        );
    });
});
