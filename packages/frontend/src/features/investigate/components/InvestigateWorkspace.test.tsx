import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
    InvestigateWorkspace,
    type InvestigateQueryResult,
    type InvestigateRunRequest,
} from './InvestigateWorkspace';

const tableResult: InvestigateQueryResult = {
    columns: ['id'],
    rows: [{ id: 7 }],
};

const renderWorkspace = (
    runQuery: (
        request: InvestigateRunRequest,
    ) => Promise<InvestigateQueryResult>,
) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            <InvestigateWorkspace runQuery={runQuery} />
        </MantineProvider>,
    );

const writePromql = (query: string) =>
    fireEvent.change(screen.getByLabelText('PromQL'), {
        target: { value: query },
    });

describe('InvestigateWorkspace', () => {
    it('keeps Run disabled until there is SQL', () => {
        renderWorkspace(vi.fn());
        expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
        writePromql('up');
        expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    });

    it('labels the result with the range it was run over', async () => {
        renderWorkspace(vi.fn(async () => tableResult));
        writePromql('up');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(await screen.findByText('7')).toBeInTheDocument();
        expect(
            screen.getByText('Results over Last 6 hours'),
        ).toBeInTheDocument();

        // Changing the control without running again leaves the label alone.
        fireEvent.click(screen.getByRole('button', { name: /Last 6 hours/ }));
        fireEvent.click(await screen.findByText('Last 1 hour'));
        expect(
            screen.getByText('Results over Last 6 hours'),
        ).toBeInTheDocument();
    });

    it('shows why a run failed', async () => {
        renderWorkspace(
            vi.fn(async () => {
                throw new Error('engine unavailable');
            }),
        );
        writePromql('up');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(await screen.findByText('Query failed')).toBeInTheDocument();
        expect(screen.getByText('engine unavailable')).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled(),
        );
    });
});
