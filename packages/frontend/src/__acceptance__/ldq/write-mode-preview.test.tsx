// ldq-write-mode-preview: Preview gets a fresh confirmation token, runs the statement in a
// transaction that always rolls back, and shows the result.
import { load } from './load';
import { fireEvent, renderUi, screen, setText, waitFor, within } from './ui';

let WriteModePanel: any;

beforeAll(async () => {
    ({ WriteModePanel } = await load(
        '../../features/investigate/components/WriteModePanel',
    ));
}, 120_000);

const statement =
    "UPDATE refills SET status = 'cancelled' WHERE id = 42 RETURNING id, status";

describe('Write Mode Preview', () => {
    it('needs a description, then previews and shows the rolled-back result', async () => {
        const api = {
            createConfirmation: vi.fn(async () => ({
                confirmationToken: 'confirmation-preview',
                expiresAt: '2026-11-08T10:02:00.000Z',
            })),
            write: vi.fn(async () => ({
                audit_id: 'audit-0001',
                rows_affected: 1,
                preview: true,
                returning: [{ id: 42, status: 'cancelled' }],
            })),
        };
        renderUi(<WriteModePanel statement={statement} api={api} />);
        expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
        setText(/Description/, 'Cancel a duplicate refill');
        setText(/Linear ticket/, 'ENG-123');
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

        await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
        expect(api.createConfirmation).toHaveBeenCalledWith(statement);
        expect(api.write).toHaveBeenCalledWith({
            statement,
            mode: 'preview',
            confirmationToken: 'confirmation-preview',
            description: 'Cancel a duplicate refill',
            ticket: 'ENG-123',
        });
        const result = await screen.findByTestId('write-mode-result');
        expect(within(result).getByText(/Rolled back/)).toBeInTheDocument();
        expect(within(result).getByText(/Rows affected: 1/)).toBeInTheDocument();
        expect(within(result).getByText('cancelled')).toBeInTheDocument();
    });

    it('shows a refusal from the engine', async () => {
        const api = {
            createConfirmation: vi.fn(async () => ({
                confirmationToken: 'confirmation-preview',
                expiresAt: '2026-11-08T10:02:00.000Z',
            })),
            write: vi.fn(async () => {
                throw new Error('DDL is always blocked');
            }),
        };
        renderUi(<WriteModePanel statement="DROP TABLE refills" api={api} />);
        setText(/Description/, 'Should be refused');
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
        expect(
            await screen.findByText(/DDL is always blocked/),
        ).toBeInTheDocument();
    });
});
