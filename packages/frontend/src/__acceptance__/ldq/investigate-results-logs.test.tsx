// ldq-investigate-results-logs: log-shaped results (logql, cloudwatch_logs) render as a log list.
import { load } from './load';
import { renderUi, screen, within } from './ui';

let InvestigateResults: any;

beforeAll(async () => {
    ({ InvestigateResults } = await load(
        '../../features/investigate/components/InvestigateResults',
    ));
}, 120_000);

describe('InvestigateResults for logs', () => {
    it('lists logql lines with their timestamps', () => {
        renderUi(
            <InvestigateResults
                columns={['timestamp', 'line', 'labels', 'stream']}
                rows={[
                    {
                        timestamp: '2026-11-08T10:00:01.000Z',
                        line: 'level=error msg="refill sync failed"',
                        labels: '{"app":"api"}',
                        stream: '{app="api"}',
                    },
                    {
                        timestamp: '2026-11-08T10:00:00.000Z',
                        line: 'level=info msg="started"',
                        labels: '{"app":"api"}',
                        stream: '{app="api"}',
                    },
                ]}
            />,
        );
        const list = screen.getByTestId('investigate-log-list');
        expect(
            within(list).getByText('level=error msg="refill sync failed"'),
        ).toBeInTheDocument();
        expect(within(list).getByText('level=info msg="started"')).toBeInTheDocument();
        expect(list.textContent).toContain('2026-11-08');
        expect(screen.queryByTestId('investigate-timeseries')).toBeNull();
    });

    it('lists cloudwatch_logs messages', () => {
        renderUi(
            <InvestigateResults
                columns={['timestamp', 'message', 'fields']}
                rows={[
                    {
                        timestamp: '2026-11-08T10:00:00.000Z',
                        message: 'Task timed out after 30.00 seconds',
                        fields: '{"@logStream":"2026/11/08/[$LATEST]abc"}',
                    },
                ]}
            />,
        );
        expect(
            within(screen.getByTestId('investigate-log-list')).getByText(
                'Task timed out after 30.00 seconds',
            ),
        ).toBeInTheDocument();
    });
});
