// ldq-platform-schema-browser: support staff browse Platform Database tables (platform_tables)
// and a table's columns (platform_columns).
import { load } from './load';
import { fireEvent, renderUi, screen, waitFor } from './ui';

let PlatformSchemaBrowser: any;

beforeAll(async () => {
    ({ PlatformSchemaBrowser } = await load(
        '../../features/investigate/components/PlatformSchemaBrowser',
    ));
}, 120_000);

describe('PlatformSchemaBrowser', () => {
    it('lists tables by schema and loads columns on demand', async () => {
        const loadTables = vi.fn(async () => [
            { table_schema: 'public', table_name: 'refills' },
            { table_schema: 'public', table_name: 'prescriptions' },
            { table_schema: 'billing', table_name: 'invoices' },
        ]);
        const loadColumns = vi.fn(async () => [
            { column_name: 'id', data_type: 'bigint', is_nullable: false },
            { column_name: 'status', data_type: 'text', is_nullable: true },
        ]);
        const onInsert = vi.fn();
        renderUi(
            <PlatformSchemaBrowser
                loadTables={loadTables}
                loadColumns={loadColumns}
                onInsert={onInsert}
            />,
        );
        expect(await screen.findByText('refills')).toBeInTheDocument();
        expect(screen.getByText('public')).toBeInTheDocument();
        expect(screen.getByText('billing')).toBeInTheDocument();
        expect(screen.getByText('invoices')).toBeInTheDocument();
        expect(loadColumns).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('refills'));
        await waitFor(() =>
            expect(loadColumns).toHaveBeenCalledWith('public', 'refills'),
        );
        expect(await screen.findByText('status')).toBeInTheDocument();
        expect(screen.getByText('bigint')).toBeInTheDocument();

        fireEvent.click(screen.getByText('status'));
        expect(onInsert).toHaveBeenCalledWith('status');
    });

    it('filters tables by name', async () => {
        renderUi(
            <PlatformSchemaBrowser
                loadTables={vi.fn(async () => [
                    { table_schema: 'public', table_name: 'refills' },
                    { table_schema: 'public', table_name: 'prescriptions' },
                ])}
                loadColumns={vi.fn(async () => [])}
                onInsert={vi.fn()}
            />,
        );
        await screen.findByText('refills');
        fireEvent.change(screen.getByLabelText('Search tables'), {
            target: { value: 'presc' },
        });
        await waitFor(() => expect(screen.queryByText('refills')).toBeNull());
        expect(screen.getByText('prescriptions')).toBeInTheDocument();
    });

    it('shows the error when the engine refuses', async () => {
        renderUi(
            <PlatformSchemaBrowser
                loadTables={vi.fn(async () => {
                    throw new Error('missing claim platform_read');
                })}
                loadColumns={vi.fn()}
                onInsert={vi.fn()}
            />,
        );
        expect(
            await screen.findByText(/missing claim platform_read/),
        ).toBeInTheDocument();
    });
});
