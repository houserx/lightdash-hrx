// ldq-write-mode-commit: committing needs an explicit typed confirmation and a description, uses
// its own confirmation token, and shows the committed result with its audit id.
import { load } from './load';
import { fireEvent, renderUi, screen, setText, waitFor, within } from './ui';

let WriteModePanel: any;

beforeAll(async () => {
    ({ WriteModePanel } = await load(
        '../../features/investigate/components/WriteModePanel',
    ));
}, 120_000);

const statement = 'DELETE FROM refill_locks WHERE refill_id = 42';

const api = () => ({
    createConfirmation: vi.fn(async () => ({
        confirmationToken: 'confirmation-commit',
        expiresAt: '2026-11-08T10:02:00.000Z',
    })),
    write: vi.fn(async (_body: any) => ({
        audit_id: 'audit-0002',
        rows_affected: 1,
        preview: false,
        returning: null,
    })),
});

describe('Write Mode commit', () => {
    it('stays disabled until COMMIT is typed and a description is given', () => {
        renderUi(<WriteModePanel statement={statement} api={api()} />);
        const commit = screen.getByRole('button', { name: 'Commit' });
        expect(commit).toBeDisabled();
        setText(/Description/, 'Release a stuck refill lock');
        expect(commit).toBeDisabled();
        setText('Type COMMIT to confirm', 'commit');
        expect(commit).toBeDisabled();
        setText('Type COMMIT to confirm', 'COMMIT');
        expect(commit).toBeEnabled();
        setText(/Description/, '  ');
        expect(commit).toBeDisabled();
    });

    it('commits and shows the result with its audit id', async () => {
        const calls = api();
        renderUi(<WriteModePanel statement={statement} api={calls} />);
        setText(/Description/, 'Release a stuck refill lock');
        setText('Type COMMIT to confirm', 'COMMIT');
        fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
        await waitFor(() => expect(calls.write).toHaveBeenCalledTimes(1));
        expect(calls.createConfirmation).toHaveBeenCalledWith(statement);
        const body = calls.write.mock.calls[0][0] as any;
        expect(body).toMatchObject({
            statement,
            mode: 'commit',
            confirmationToken: 'confirmation-commit',
            description: 'Release a stuck refill lock',
        });
        expect(body.ticket ?? null).toBeNull();
        const result = await screen.findByTestId('write-mode-result');
        expect(within(result).getByText(/Committed/)).toBeInTheDocument();
        expect(within(result).getByText(/Rows affected: 1/)).toBeInTheDocument();
        expect(within(result).getByText(/audit-0002/)).toBeInTheDocument();
    });

    it('asks for a new confirmation after a commit', async () => {
        const calls = api();
        renderUi(<WriteModePanel statement={statement} api={calls} />);
        setText(/Description/, 'Release a stuck refill lock');
        setText('Type COMMIT to confirm', 'COMMIT');
        fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
        await screen.findByTestId('write-mode-result');
        expect(
            (screen.getByLabelText('Type COMMIT to confirm') as HTMLInputElement)
                .value,
        ).toBe('');
        expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    });
});
