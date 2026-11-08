// ldq-investigate-results-traces: trace-shaped results (traceql, trace) render as a trace table;
// clicking a trace id asks for that trace.
import { load } from './load';
import { fireEvent, renderUi, screen, within } from './ui';

let InvestigateResults: any;

beforeAll(async () => {
    ({ InvestigateResults } = await load(
        '../../features/investigate/components/InvestigateResults',
    ));
}, 120_000);

describe('InvestigateResults for traces', () => {
    it('renders a trace table with service, name and duration', () => {
        const onOpenTrace = vi.fn();
        renderUi(
            <InvestigateResults
                columns={[
                    'trace_id',
                    'root_service',
                    'root_name',
                    'start',
                    'duration_ms',
                    'span_count',
                ]}
                rows={[
                    {
                        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
                        root_service: 'api',
                        root_name: 'POST /refills',
                        start: '2026-11-08T10:00:00.000Z',
                        duration_ms: 2350.5,
                        span_count: 42,
                    },
                ]}
                onOpenTrace={onOpenTrace}
            />,
        );
        const table = screen.getByTestId('investigate-trace-table');
        expect(within(table).getByText('api')).toBeInTheDocument();
        expect(within(table).getByText('POST /refills')).toBeInTheDocument();
        expect(table.textContent).toContain('2350.5');
        fireEvent.click(within(table).getByText('4bf92f3577b34da6a3ce929d0e0e4736'));
        expect(onOpenTrace).toHaveBeenCalledWith('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(screen.queryByTestId('investigate-timeseries')).toBeNull();
    });

    it('renders the spans of one trace', () => {
        renderUi(
            <InvestigateResults
                columns={[
                    'trace_id',
                    'span_id',
                    'parent_span_id',
                    'service',
                    'name',
                    'start',
                    'duration_ms',
                    'status',
                    'attributes',
                ]}
                rows={[
                    {
                        trace_id: 't1',
                        span_id: 's1',
                        parent_span_id: null,
                        service: 'api',
                        name: 'POST /refills',
                        start: '2026-11-08T10:00:00.000Z',
                        duration_ms: 20,
                        status: 'error',
                        attributes: '{}',
                    },
                ]}
            />,
        );
        const table = screen.getByTestId('investigate-trace-table');
        expect(within(table).getByText('error')).toBeInTheDocument();
    });

    it('falls back to a plain table for other shapes', () => {
        renderUi(
            <InvestigateResults
                columns={['id', 'status']}
                rows={[{ id: 42, status: 'stuck' }]}
            />,
        );
        expect(screen.getByText('stuck')).toBeInTheDocument();
        expect(screen.queryByTestId('investigate-trace-table')).toBeNull();
        expect(screen.queryByTestId('investigate-log-list')).toBeNull();
    });
});
