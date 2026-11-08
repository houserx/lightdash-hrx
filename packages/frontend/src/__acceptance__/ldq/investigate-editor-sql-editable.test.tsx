// ldq-investigate-sql-editable: the generated SQL stays visible and editable; edits are what runs.
import { load } from './load';
import { fireEvent, renderUi, screen, setText, textOf, waitFor } from './ui';

let InvestigateEditor: any;

beforeAll(async () => {
    ({ InvestigateEditor } = await load(
        '../../features/investigate/components/InvestigateEditor',
    ));
}, 120_000);

describe('InvestigateEditor SQL', () => {
    it('shows the SQL and reports manual edits', async () => {
        const onChange = vi.fn();
        renderUi(<InvestigateEditor onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'up');
        await waitFor(() => expect(textOf('SQL')).toContain("promql('up'"));
        expect(screen.getByLabelText('SQL')).not.toBeDisabled();
        expect(screen.getByLabelText('SQL')).not.toHaveAttribute('readonly');

        const edited =
            "SELECT timestamp, value FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}) WHERE label(labels, 'job') = 'api'";
        setText('SQL', edited);
        await waitFor(() =>
            expect(onChange).toHaveBeenLastCalledWith(
                expect.objectContaining({ sql: edited }),
            ),
        );
        expect(textOf('SQL')).toBe(edited);
    });

    it('starts from an initial SQL when given one', () => {
        const initialSql =
            "SELECT * FROM promql('rate(x[1m])', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})";
        renderUi(
            <InvestigateEditor onChange={vi.fn()} initialSql={initialSql} />,
        );
        expect(textOf('SQL')).toBe(initialSql);
    });
});
