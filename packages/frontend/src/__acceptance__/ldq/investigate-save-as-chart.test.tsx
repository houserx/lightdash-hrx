// ldq-investigate-save-as-chart: "Save as chart" saves the current Investigate SQL as a SQL chart.
import { fireEvent, renderUi, screen, setText, waitFor } from './ui';
import { loadWorkspace, metricResult, noAccess } from './workspace';

let InvestigateWorkspace: any;

beforeAll(async () => {
    InvestigateWorkspace = await loadWorkspace();
}, 120_000);

describe('Save as chart', () => {
    it('saves the SQL under the chosen name', async () => {
        const onSaveAsChart = vi.fn(async () => undefined);
        renderUi(
            <InvestigateWorkspace
                access={noAccess}
                runQuery={vi.fn(async () => metricResult)}
                onSaveAsChart={onSaveAsChart}
            />,
        );
        fireEvent.click(screen.getByRole('radio', { name: 'Prometheus' }));
        setText('PromQL', 'sum(rate(http_requests_total[5m]))');
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        await screen.findByTestId('investigate-timeseries');

        fireEvent.click(screen.getByRole('button', { name: 'Save as chart' }));
        await screen.findByLabelText('Chart name');
        setText('Chart name', 'API request rate');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onSaveAsChart).toHaveBeenCalledTimes(1));
        expect(onSaveAsChart).toHaveBeenCalledWith({
            name: 'API request rate',
            sql: "SELECT * FROM promql('sum(rate(http_requests_total[5m]))', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
        });
    });

    it('is unavailable until there is SQL', () => {
        renderUi(
            <InvestigateWorkspace
                access={noAccess}
                runQuery={vi.fn()}
                onSaveAsChart={vi.fn()}
            />,
        );
        expect(
            screen.getByRole('button', { name: 'Save as chart' }),
        ).toBeDisabled();
    });
});
