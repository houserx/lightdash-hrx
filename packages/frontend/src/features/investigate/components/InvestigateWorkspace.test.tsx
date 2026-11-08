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

    it('asks for audit fields only while the SQL touches the Platform Database', async () => {
        const runQuery = vi.fn(async () => tableResult);
        renderWorkspace(runQuery);
        fireEvent.click(
            screen.getByRole('radio', { name: 'Platform Database' }),
        );
        fireEvent.change(screen.getByLabelText('Platform SQL'), {
            target: { value: 'select 1' },
        });
        fireEvent.change(screen.getByLabelText(/Description/), {
            target: { value: '   ' },
        });
        expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/Description/), {
            target: { value: '  Smoke test  ' },
        });
        fireEvent.change(screen.getByLabelText(/Linear ticket/), {
            target: { value: '  ' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
        expect(runQuery.mock.calls[0]).toEqual([
            expect.objectContaining({ audit: { description: 'Smoke test' } }),
        ]);

        // Editing the SQL so it no longer calls platform_query drops the fields and the audit.
        fireEvent.change(screen.getByLabelText('SQL'), {
            target: { value: 'select 1' },
        });
        expect(screen.queryByLabelText(/Description/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
        expect(runQuery.mock.calls[1]).toEqual([
            expect.not.objectContaining({ audit: expect.anything() }),
        ]);
    });

    it('asks for audit fields when the engine requires them, for that SQL only', async () => {
        const descriptionRequired = new Error(
            'ERROR: audited query requires a description (SQLSTATE 42501)',
        );
        const runQuery = vi
            .fn()
            .mockRejectedValueOnce(descriptionRequired)
            .mockRejectedValueOnce(descriptionRequired);
        renderWorkspace(runQuery);
        writePromql('up');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(await screen.findByLabelText(/Description/)).toBeRequired();
        expect(screen.queryByText('Query failed')).toBeNull();
        expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

        // Refused again even with a description: shown as a failure, not another prompt.
        fireEvent.change(screen.getByLabelText(/Description/), {
            target: { value: 'Checking an alert' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(await screen.findByText('Query failed')).toBeInTheDocument();
        expect(runQuery.mock.calls[1]).toEqual([
            expect.objectContaining({
                audit: { description: 'Checking an alert' },
            }),
        ]);

        // Different SQL is not covered by the engine's request.
        writePromql('rate(up[5m])');
        expect(screen.queryByLabelText(/Description/)).toBeNull();
    });

    it('hides Save as chart when the page cannot save charts', async () => {
        renderWorkspace(vi.fn());
        expect(
            screen.queryByRole('button', { name: 'Save as chart' }),
        ).toBeNull();
    });

    it('keeps the Save as chart dialog open with the reason when saving fails', async () => {
        const onSaveAsChart = vi
            .fn()
            .mockRejectedValueOnce(new Error('no space to save in'))
            .mockResolvedValueOnce(undefined);
        render(
            <MantineProvider env="test" forceColorScheme="light">
                <InvestigateWorkspace
                    runQuery={vi.fn()}
                    onSaveAsChart={onSaveAsChart}
                />
            </MantineProvider>,
        );
        writePromql('up');
        fireEvent.click(screen.getByRole('button', { name: 'Save as chart' }));
        fireEvent.change(await screen.findByLabelText('Chart name'), {
            target: { value: '  Up  ' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(
            await screen.findByText('no space to save in'),
        ).toBeInTheDocument();
        expect(screen.getByLabelText('Chart name')).toHaveValue('  Up  ');

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(screen.queryByLabelText('Chart name')).toBeNull(),
        );
        expect(onSaveAsChart).toHaveBeenLastCalledWith({
            name: 'Up',
            sql: expect.stringContaining("promql('up'"),
        });
    });

    it('opens the schema browser on demand and inserts a clicked column into the Platform SQL', async () => {
        const loadTables = vi.fn(async () => [
            { table_schema: 'public', table_name: 'refills' },
        ]);
        const loadColumns = vi.fn(async () => [
            { column_name: 'status', data_type: 'text', is_nullable: true },
        ]);
        render(
            <MantineProvider env="test" forceColorScheme="light">
                <InvestigateWorkspace
                    runQuery={vi.fn()}
                    platformSchema={{ loadTables, loadColumns }}
                />
            </MantineProvider>,
        );
        expect(
            screen.queryByRole('button', { name: 'Browse tables' }),
        ).toBeNull();
        fireEvent.click(
            screen.getByRole('radio', { name: 'Platform Database' }),
        );
        fireEvent.change(screen.getByLabelText('Platform SQL'), {
            target: { value: 'SELECT  FROM refills' },
        });
        // Catalog reads are Audited Queries: nothing loads until the browser is opened.
        expect(loadTables).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Browse tables' }));
        fireEvent.click(await screen.findByText('refills'));
        const platformSql = screen.getByLabelText(
            'Platform SQL',
        ) as HTMLTextAreaElement;
        platformSql.setSelectionRange(7, 7);
        fireEvent.click(await screen.findByText('status'));
        expect(platformSql).toHaveValue('SELECT status FROM refills');
        await waitFor(() =>
            expect(screen.getByLabelText('SQL')).toHaveValue(
                "SELECT * FROM platform_query('SELECT status FROM refills')",
            ),
        );
    });

    it('explains the Platform SQL, not the SQL box, and shows why an explain failed', async () => {
        const runQuery = vi.fn(async (request: InvestigateRunRequest) => {
            if (request.sql.includes("'select 2'")) {
                throw new Error('permission denied: platform_explain');
            }
            return {
                columns: ['plan'],
                rows: [
                    {
                        plan: [
                            {
                                Plan: {
                                    'Node Type': 'Result',
                                    'Startup Cost': 0,
                                    'Total Cost': 0.01,
                                    'Plan Rows': 1,
                                    'Plan Width': 4,
                                },
                            },
                        ],
                    },
                ],
            };
        });
        renderWorkspace(runQuery);
        fireEvent.click(
            screen.getByRole('radio', { name: 'Platform Database' }),
        );
        fireEvent.change(screen.getByLabelText('Platform SQL'), {
            target: { value: 'select 1' },
        });
        expect(screen.getByRole('button', { name: 'Explain' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/Description/), {
            target: { value: 'Plan check' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
        expect(
            await screen.findByText(
                'Result  (cost=0.00..0.01 rows=1 width=4)',
                { normalizer: (text) => text },
            ),
        ).toBeInTheDocument();
        expect(runQuery.mock.calls[0][0]).toMatchObject({
            sql: "SELECT plan FROM platform_explain('select 1')",
            audit: { description: 'Plan check' },
        });
        expect(screen.queryByText(/Results over/)).toBeNull();

        fireEvent.change(screen.getByLabelText('Platform SQL'), {
            target: { value: 'select 2' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
        expect(await screen.findByText('Explain failed')).toBeInTheDocument();
        expect(
            screen.getByText('permission denied: platform_explain'),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole('link', { name: 'Download JSON' }),
        ).toBeNull();

        // Clearing the Platform SQL leaves nothing to explain.
        fireEvent.change(screen.getByLabelText('Platform SQL'), {
            target: { value: '' },
        });
        expect(screen.getByRole('button', { name: 'Explain' })).toBeDisabled();
    });

    it('opens shared saved SQL from the Saved SQL list and runs it', async () => {
        const items = [
            {
                uuid: 'saved-1',
                name: 'Open refills by status',
                description: 'Synthetic test script',
                spaceName: 'Platform saved SQL',
            },
            {
                uuid: 'saved-2',
                name: 'Error rate',
                description: null,
                spaceName: 'Service health',
            },
        ];
        const savedSqlText =
            "SELECT * FROM platform_query('select status, count(*) from refills group by 1')";
        const loadItems = vi.fn(async () => items);
        const loadSql = vi.fn(async (item: { uuid: string }) => {
            if (item.uuid === 'saved-2') throw new Error('Chart not found');
            return savedSqlText;
        });
        const runQuery = vi.fn(async () => tableResult);
        render(
            <MantineProvider env="test" forceColorScheme="light">
                <InvestigateWorkspace
                    runQuery={runQuery}
                    savedSql={{ loadItems, loadSql }}
                />
            </MantineProvider>,
        );
        // The list loads only when the user opens it.
        expect(loadItems).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Saved SQL' }));
        expect(await screen.findByText('Error rate')).toBeInTheDocument();
        expect(screen.getByText('Synthetic test script')).toBeInTheDocument();
        expect(screen.getByText('Service health')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Search saved SQL'), {
            target: { value: 'health' },
        });
        expect(screen.queryByText('Open refills by status')).toBeNull();
        fireEvent.click(screen.getByText('Error rate'));
        expect(
            await screen.findByText('Could not open Error rate'),
        ).toBeInTheDocument();
        expect(screen.getByText('Chart not found')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Search saved SQL'), {
            target: { value: '' },
        });
        fireEvent.click(screen.getByText('Open refills by status'));
        await waitFor(() =>
            expect(screen.getByLabelText('SQL')).toHaveValue(savedSqlText),
        );
        expect(loadSql).toHaveBeenLastCalledWith(items[0]);
        // Saved Platform Database SQL is still an Audited Query.
        fireEvent.change(screen.getByLabelText(/Description/), {
            target: { value: 'Weekly check' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() =>
            expect(runQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: savedSqlText,
                    audit: { description: 'Weekly check' },
                }),
            ),
        );
    });
});
