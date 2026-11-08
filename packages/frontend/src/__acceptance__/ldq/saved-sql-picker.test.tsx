// ldq-saved-sql-picker: shared saved SQL in the Operations Project's spaces can be opened in
// Investigate.
import { load } from './load';
import { fireEvent, renderUi, screen, waitFor } from './ui';

let SavedSqlPicker: any;

beforeAll(async () => {
    ({ SavedSqlPicker } = await load(
        '../../features/investigate/components/SavedSqlPicker',
    ));
}, 120_000);

const items = [
    {
        uuid: 'saved-1',
        name: 'Stuck refills by status',
        description: 'Refills that have not moved in a week',
        spaceName: 'Platform saved SQL',
        sql: "SELECT * FROM platform_query('select status, count(*) from refills group by 1')",
    },
    {
        uuid: 'saved-2',
        name: 'API error rate',
        description: null,
        spaceName: 'Service health',
        sql: "SELECT * FROM promql('sum(rate(http_requests_total{status=~\"5..\"}[5m]))', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
    },
];

describe('SavedSqlPicker', () => {
    it('lists saved SQL with its space and opens one', () => {
        const onSelect = vi.fn();
        renderUi(<SavedSqlPicker items={items} onSelect={onSelect} />);
        expect(screen.getByText('Stuck refills by status')).toBeInTheDocument();
        expect(screen.getByText('Platform saved SQL')).toBeInTheDocument();
        expect(
            screen.getByText('Refills that have not moved in a week'),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByText('API error rate'));
        expect(onSelect).toHaveBeenCalledWith(items[1]);
    });

    it('searches by name', async () => {
        renderUi(<SavedSqlPicker items={items} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Search saved SQL'), {
            target: { value: 'refill' },
        });
        await waitFor(() =>
            expect(screen.queryByText('API error rate')).toBeNull(),
        );
        expect(screen.getByText('Stuck refills by status')).toBeInTheDocument();
    });

    it('says when there is none', () => {
        renderUi(<SavedSqlPicker items={[]} onSelect={vi.fn()} />);
        expect(screen.getByText('No saved SQL yet')).toBeInTheDocument();
    });
});
