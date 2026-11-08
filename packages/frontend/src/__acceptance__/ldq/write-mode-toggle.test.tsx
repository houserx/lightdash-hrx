// ldq-write-mode-toggle: the Write Mode toggle in Investigate is shown only to users with
// platform_write, and opens Write Mode for the current Platform Database statement.
import { fireEvent, renderUi, screen, setText, within } from './ui';
import { loadWorkspace, noAccess } from './workspace';

let InvestigateWorkspace: any;

beforeAll(async () => {
    InvestigateWorkspace = await loadWorkspace();
}, 120_000);

const writeApi = {
    createConfirmation: vi.fn(),
    write: vi.fn(),
};

describe('Write Mode toggle', () => {
    it('is hidden without platform_write', () => {
        renderUi(
            <InvestigateWorkspace
                access={{ ...noAccess, platform_read: true }}
                runQuery={vi.fn()}
                onSaveAsChart={vi.fn()}
                writeApi={writeApi}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        expect(screen.queryByLabelText('Write Mode')).toBeNull();
    });

    it('opens Write Mode with the current statement for writers', async () => {
        renderUi(
            <InvestigateWorkspace
                access={{ ...noAccess, platform_read: true, platform_write: true }}
                runQuery={vi.fn()}
                onSaveAsChart={vi.fn()}
                writeApi={writeApi}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        setText('Platform SQL', "UPDATE refills SET status = 'cancelled' WHERE id = 42");
        expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
        fireEvent.click(screen.getByLabelText('Write Mode'));
        expect(
            await screen.findByRole('button', { name: 'Preview' }),
        ).toBeInTheDocument();
        expect(
            within(screen.getByTestId('write-mode-panel')).getByText(
                "UPDATE refills SET status = 'cancelled' WHERE id = 42",
            ),
        ).toBeInTheDocument();
    });
});
