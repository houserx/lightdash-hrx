// ldq-audit-browser-ui: a page lists Audited Query executions from the engine's audit store,
// filtered by ticket, user and month. It needs platform_read.
import { load } from './load';
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';

let AuditBrowser: any;

beforeAll(async () => {
    ({ AuditBrowser } = await load(
        '../../features/auditBrowser/components/AuditBrowser',
    ));
}, 120_000);

const execution = (id: string, description: string) => ({
    id,
    sql: 'SELECT status FROM refills WHERE id = 42',
    mode: 'read',
    description,
    database: 'platform',
    linearTicketId: 'ENG-123',
    executedByEmail: 'support.one@example.com',
    executedBySub: 'user-sub-1',
    status: 'success',
    rowCount: 1,
    durationMs: 12,
    errorMessage: null,
    preview: false,
    action: 'query',
    integrityHash: 'synthetic-hash',
    createdAt: '2026-11-03T12:00:00.000Z',
    createdAtMonth: '2026-11',
});

describe('AuditBrowser', () => {
    it('lists executions and applies filters', async () => {
        const fetchPage = vi.fn(async () => ({
            items: [execution('exec-1', 'Check a refill status')],
            nextCursor: null,
        }));
        renderUi(<AuditBrowser canRead fetchPage={fetchPage} />);
        expect(await screen.findByText('Check a refill status')).toBeInTheDocument();
        expect(screen.getByText('support.one@example.com')).toBeInTheDocument();
        expect(screen.getByText('ENG-123')).toBeInTheDocument();
        expect(fetchPage).toHaveBeenCalledWith({});

        setText('Ticket', 'ENG-123');
        setText('User', 'support.one@example.com');
        setText('Month', '2026-11');
        fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
        await waitFor(() =>
            expect(fetchPage).toHaveBeenLastCalledWith({
                ticket: 'ENG-123',
                user: 'support.one@example.com',
                month: '2026-11',
            }),
        );
    });

    it('needs platform_read', () => {
        const fetchPage = vi.fn();
        renderUi(<AuditBrowser canRead={false} fetchPage={fetchPage} />);
        expect(screen.getByText(/platform_read/)).toBeInTheDocument();
        expect(fetchPage).not.toHaveBeenCalled();
    });
});
