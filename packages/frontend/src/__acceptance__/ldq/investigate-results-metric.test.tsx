// ldq-investigate-results-timeseries: metric-shaped results render as a time-series chart,
// one line per series.
import { load } from './load';
import { renderUi, screen } from './ui';

let InvestigateResults: any;

beforeAll(async () => {
    ({ InvestigateResults } = await load(
        '../../features/investigate/components/InvestigateResults',
    ));
}, 120_000);

const rows = [
    { timestamp: '2026-11-08T10:00:00.000Z', value: 1, labels: '{"status":"200"}', series: '{status="200"}' },
    { timestamp: '2026-11-08T10:00:30.000Z', value: 2, labels: '{"status":"200"}', series: '{status="200"}' },
    { timestamp: '2026-11-08T10:00:00.000Z', value: 0.5, labels: '{"status":"500"}', series: '{status="500"}' },
];

describe('InvestigateResults for metrics', () => {
    it('renders a time-series chart instead of a log list or trace table', () => {
        renderUi(
            <InvestigateResults
                columns={['timestamp', 'value', 'labels', 'series']}
                rows={rows}
            />,
        );
        const chart = screen.getByTestId('investigate-timeseries');
        expect(chart).toBeInTheDocument();
        expect(chart.getAttribute('data-series-count')).toBe('2');
        expect(screen.queryByTestId('investigate-log-list')).toBeNull();
        expect(screen.queryByTestId('investigate-trace-table')).toBeNull();
    });
});
