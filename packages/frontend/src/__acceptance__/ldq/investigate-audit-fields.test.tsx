// ldq-investigate-audited-query: SQL that touches platform_* requires a description and offers
// an optional Linear ticket; both travel with the run (into the identity token's audit block).
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';
import { loadWorkspace, noAccess } from './workspace';

let InvestigateWorkspace: any;

beforeAll(async () => {
    InvestigateWorkspace = await loadWorkspace();
}, 120_000);

const reader = { ...noAccess, platform_read: true };
const tableResult = { columns: ['id'], rows: [{ id: 42 }] };

describe('Audited Query fields', () => {
    it('are not asked for ordinary telemetry', () => {
        renderUi(
            <InvestigateWorkspace
                access={reader}
                runQuery={vi.fn()}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'up');
        expect(screen.queryByLabelText(/Description/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    });

    it('require a description before a Platform Database run', async () => {
        const runQuery = vi.fn(async (_request: any) => tableResult);
        renderUi(
            <InvestigateWorkspace
                access={reader}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        setText('Platform SQL', 'select id from refills limit 1');
        expect(screen.getByLabelText(/Description/)).toBeRequired();
        expect(screen.getByLabelText(/Linear ticket/)).not.toBeRequired();
        expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

        setText(/Description/, 'Checking a stuck refill');
        setText(/Linear ticket/, 'ENG-123');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
        expect(runQuery.mock.calls[0][0]).toMatchObject({
            sql: "SELECT * FROM platform_query('select id from refills limit 1')",
            audit: { description: 'Checking a stuck refill', ticket: 'ENG-123' },
        });
        expect(await screen.findByText('42')).toBeInTheDocument();
    });

    it('send no ticket when none is given', async () => {
        const runQuery = vi.fn(async (_request: any) => tableResult);
        renderUi(
            <InvestigateWorkspace
                access={reader}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        setText('Platform SQL', 'select 1');
        setText(/Description/, 'Smoke test');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
        const { audit } = runQuery.mock.calls[0][0] as any;
        expect(audit.description).toBe('Smoke test');
        expect(audit.ticket ?? null).toBeNull();
    });
});
