// ldq-investigate-restricted-description: when the engine answers "audited query requires a
// description" (e.g. a Restricted Telemetry selector), Investigate asks for one and reruns.
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';
import { loadWorkspace, noAccess } from './workspace';

let InvestigateWorkspace: any;

beforeAll(async () => {
    InvestigateWorkspace = await loadWorkspace();
}, 120_000);

const logResult = {
    columns: ['timestamp', 'line', 'labels', 'stream'],
    rows: [
        {
            timestamp: '2026-11-08T10:00:00.000Z',
            line: 'synthetic log line',
            labels: '{}',
            stream: '{namespace="platform"}',
        },
    ],
};

describe('engine-requested Audited Query description', () => {
    it('asks for a description and reruns with it', async () => {
        const runQuery = vi
            .fn()
            .mockRejectedValueOnce(
                new Error(
                    'ERROR: audited query requires a description (SQLSTATE 42501)',
                ),
            )
            .mockResolvedValueOnce(logResult);
        renderUi(
            <InvestigateWorkspace
                access={{ ...noAccess, telemetry_restricted: true }}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Loki' }));
        setText('LogQL', '{namespace="platform"}');
        expect(screen.queryByLabelText(/Description/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));

        expect(await screen.findByLabelText(/Description/)).toBeRequired();
        expect(screen.getByLabelText(/Linear ticket/)).toBeInTheDocument();
        expect(runQuery.mock.calls[0][0].audit).toBeUndefined();

        setText(/Description/, 'Tracing a failed fill for a ticket');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
        expect(runQuery.mock.calls[1][0].audit).toMatchObject({
            description: 'Tracing a failed fill for a ticket',
        });
        expect(await screen.findByText('synthetic log line')).toBeInTheDocument();
    });

    it('shows other engine errors without asking for a description', async () => {
        const runQuery = vi
            .fn()
            .mockRejectedValueOnce(
                new Error('missing claim telemetry_restricted (SQLSTATE 42501)'),
            );
        renderUi(
            <InvestigateWorkspace
                access={noAccess}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Loki' }));
        setText('LogQL', '{namespace="platform"}');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(
            await screen.findByText(/missing claim telemetry_restricted/),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText(/Description/)).toBeNull();
    });
});
