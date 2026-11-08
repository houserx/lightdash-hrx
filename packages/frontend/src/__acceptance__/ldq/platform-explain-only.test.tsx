// ldq-platform-explain-only: users with platform_explain and without platform_read get Explain
// (estimate-only plan, downloadable as JSON or text) but cannot run Platform Database SQL.
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';
import { loadWorkspace, noAccess } from './workspace';

let InvestigateWorkspace: any;

beforeAll(async () => {
    InvestigateWorkspace = await loadWorkspace();
}, 120_000);

const plan = [
    {
        Plan: {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            'Startup Cost': 0,
            'Total Cost': 1.04,
            'Plan Rows': 4,
            'Plan Width': 40,
        },
    },
];

describe('Explain-only experience', () => {
    it('offers Explain but no Run, and shows the plan with downloads', async () => {
        const runQuery = vi.fn(async (_request: any) => ({
            columns: ['plan'],
            rows: [{ plan: JSON.stringify(plan) }],
        }));
        renderUi(
            <InvestigateWorkspace
                access={{ ...noAccess, platform_explain: true }}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        setText('Platform SQL', 'select * from orders');
        expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
        setText(/Description/, 'Why is the orders query slow?');
        fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
        expect(runQuery.mock.calls[0][0]).toMatchObject({
            sql: "SELECT plan FROM platform_explain('select * from orders')",
            audit: { description: 'Why is the orders query slow?' },
        });

        expect(
            await screen.findByText(
                'Seq Scan on orders  (cost=0.00..1.04 rows=4 width=40)',
                { normalizer: (text) => text },
            ),
        ).toBeInTheDocument();
        const json = screen.getByRole('link', { name: 'Download JSON' });
        expect(json).toHaveAttribute('download', 'explain-plan.json');
        expect(
            JSON.parse(
                decodeURIComponent(
                    String(json.getAttribute('href')).replace(
                        /^data:application\/json;charset=utf-8,/,
                        '',
                    ),
                ),
            ),
        ).toEqual(plan);
        const text = screen.getByRole('link', { name: 'Download text' });
        expect(text).toHaveAttribute('download', 'explain-plan.txt');
        expect(
            decodeURIComponent(
                String(text.getAttribute('href')).replace(
                    /^data:text\/plain;charset=utf-8,/,
                    '',
                ),
            ),
        ).toBe('Seq Scan on orders  (cost=0.00..1.04 rows=4 width=40)');
    });

    it('gives readers both Run and Explain', () => {
        renderUi(
            <InvestigateWorkspace
                access={{ ...noAccess, platform_read: true }}
                runQuery={vi.fn()}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Explain' })).toBeInTheDocument();
    });

    it('gives neither to users with no Platform Database claim', () => {
        renderUi(
            <InvestigateWorkspace
                access={noAccess}
                runQuery={vi.fn()}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    });
});
