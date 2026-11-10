// ldq-audit-browser-pagination: the audit browser pages with the engine's cursor, keeping filters.
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
    sql: 'SELECT 1',
    mode: 'read',
    description,
    database: 'platform',
    executedByEmail: 'support.two@example.com',
    executedBySub: 'user-sub-2',
    status: 'success',
    rowCount: 1,
    durationMs: 3,
    errorMessage: null,
    preview: false,
    action: 'query',
    integrityHash: 'synthetic-hash',
    createdAt: '2026-11-04T08:00:00.000Z',
    createdAtMonth: '2026-11',
});

describe('AuditBrowser pagination', () => {
    it('follows nextCursor with the active filters and stops at the end', async () => {
        const fetchPage = vi.fn(async (query: { cursor?: string }) =>
            query.cursor === 'cursor-2'
                ? { items: [execution('exec-2', 'Second page item')], nextCursor: null }
                : { items: [execution('exec-1', 'First page item')], nextCursor: 'cursor-2' },
        );
        renderUi(<AuditBrowser canRead fetchPage={fetchPage} />);
        await screen.findByText('First page item');
        setText('Month', '2026-11');
        fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
        await waitFor(() =>
            expect(fetchPage).toHaveBeenLastCalledWith({ month: '2026-11' }),
        );
        await screen.findByText('First page item');

        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() =>
            expect(fetchPage).toHaveBeenLastCalledWith({
                month: '2026-11',
                cursor: 'cursor-2',
            }),
        );
        expect(await screen.findByText('Second page item')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    });
});
