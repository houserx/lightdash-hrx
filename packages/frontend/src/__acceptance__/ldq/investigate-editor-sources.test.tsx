// ldq-investigate-source-editors: a source picker chooses the Telemetry Source language and the
// matching editor generates §1.1 table-function SQL with the reserved time parameters.
import { load } from './load';
import { fireEvent, renderUi, screen, setText, textOf, waitFor } from './ui';

let InvestigateEditor: any;

beforeAll(async () => {
    ({ InvestigateEditor } = await load(
        '../../features/investigate/components/InvestigateEditor',
    ));
}, 120_000);

const last = (onChange: ReturnType<typeof vi.fn>) =>
    onChange.mock.calls[onChange.mock.calls.length - 1][0];

describe('InvestigateEditor sources', () => {
    it('offers every source language', () => {
        renderUi(<InvestigateEditor onChange={vi.fn()} />);
        for (const name of [
            'Prometheus',
            'Loki',
            'CloudWatch metrics',
            'CloudWatch Logs',
            'Tempo',
            'Platform Database',
        ]) {
            expect(screen.getByRole('radio', { name })).toBeInTheDocument();
        }
    });

    it('generates promql SQL from the PromQL editor', async () => {
        const onChange = vi.fn();
        renderUi(<InvestigateEditor onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'sum(rate(http_requests_total[5m]))');
        const expected =
            "SELECT * FROM promql('sum(rate(http_requests_total[5m]))', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})";
        await waitFor(() => expect(textOf('SQL')).toBe(expected));
        expect(last(onChange)).toEqual({ kind: 'promql', sql: expected });
    });

    it('generates logql and logql_metric SQL from the LogQL editor', async () => {
        const onChange = vi.fn();
        renderUi(<InvestigateEditor onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Loki' }));
        setText('LogQL', '{app="api"} |= "error"');
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                "SELECT * FROM logql('{app=\"api\"} |= \"error\"', ${ld.parameters.__from}, ${ld.parameters.__to}, 1000, 'backward')",
            ),
        );
        fireEvent.click(screen.getByLabelText('Metric query'));
        setText('LogQL', 'sum(rate({app="api"}[5m]))');
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                "SELECT * FROM logql_metric('sum(rate({app=\"api\"}[5m]))', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            ),
        );
        expect(last(onChange).kind).toBe('logql_metric');
    });

    it('generates traceql SQL from the TraceQL editor', async () => {
        const onChange = vi.fn();
        renderUi(<InvestigateEditor onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Tempo' }));
        setText('TraceQL', '{ status = error }');
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                "SELECT * FROM traceql('{ status = error }', ${ld.parameters.__from}, ${ld.parameters.__to}, 20)",
            ),
        );
        expect(last(onChange).kind).toBe('traceql');
    });

    it('wraps Platform Database SQL in platform_query', async () => {
        const onChange = vi.fn();
        renderUi(<InvestigateEditor onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Platform Database' }));
        setText('Platform SQL', "select id from refills where status = 'stuck'");
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                "SELECT * FROM platform_query('select id from refills where status = ''stuck''')",
            ),
        );
        expect(last(onChange)).toMatchObject({
            kind: 'platform',
            statement: "select id from refills where status = 'stuck'",
        });
    });

    it('appends an optional named source', async () => {
        renderUi(<InvestigateEditor onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'up');
        setText('Source name', 'prometheus-staging');
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'prometheus-staging')",
            ),
        );
    });
});
