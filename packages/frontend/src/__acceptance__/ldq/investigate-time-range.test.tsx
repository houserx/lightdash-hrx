// ldq-investigate-time-range: Investigate has a time range control shared with the result; every
// run carries the range that resolves the reserved time parameters.
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';
import { loadWorkspace, metricResult, noAccess } from './workspace';

let InvestigateWorkspace: any;

beforeAll(async () => {
    InvestigateWorkspace = await loadWorkspace();
}, 120_000);

const promql =
    "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})";

describe('Investigate time range', () => {
    it('runs over the last 6 hours by default, then over the chosen range', async () => {
        const runQuery = vi.fn(async (_request: any) => metricResult);
        renderUi(
            <InvestigateWorkspace
                access={noAccess}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'up');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(1));
        expect(runQuery.mock.calls[0][0]).toEqual({
            sql: promql,
            timeRange: { from: 'now-6h', to: 'now' },
        });
        expect(
            await screen.findByTestId('investigate-timeseries'),
        ).toBeInTheDocument();

        fireEvent.click(
            screen.getAllByRole('button', { name: /Last 6 hours/ })[0],
        );
        fireEvent.click(await screen.findByText('Last 1 hour'));
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
        expect(runQuery.mock.calls[1][0]).toMatchObject({
            sql: promql,
            timeRange: { from: 'now-1h', to: 'now' },
        });
    });

    it('starts from an initial time range when given one', async () => {
        const runQuery = vi.fn(async (_request: any) => metricResult);
        renderUi(
            <InvestigateWorkspace
                access={noAccess}
                runQuery={runQuery}
                onSaveAsChart={vi.fn()}
                initialTimeRange={{ from: 'now-24h', to: 'now' }}
            />,
        );
        expect(screen.getAllByText('Last 24 hours').length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'up');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() =>
            expect(runQuery.mock.calls[0][0].timeRange).toEqual({
                from: 'now-24h',
                to: 'now',
            }),
        );
    });
});
