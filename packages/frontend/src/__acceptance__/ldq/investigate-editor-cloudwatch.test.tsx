// ldq-investigate-cloudwatch-editors: the CloudWatch metric query is edited as JSON with a form,
// and Logs Insights queries take log groups plus a query.
import { load } from './load';
import { fireEvent, renderUi, screen, setText, textOf, waitFor } from './ui';

let InvestigateEditor: any;

beforeAll(async () => {
    ({ InvestigateEditor } = await load(
        '../../features/investigate/components/InvestigateEditor',
    ));
}, 120_000);

describe('CloudWatch editors', () => {
    it('builds the MetricDataQuery JSON from the form', async () => {
        renderUi(<InvestigateEditor onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole('radio', { name: 'CloudWatch metrics' }));
        setText('Namespace', 'AWS/SQS');
        setText('Metric name', 'ApproximateNumberOfMessagesVisible');
        setText('Dimensions', 'QueueName=fills');
        setText('Statistic', 'Maximum');
        setText('Period', '60');
        const query = {
            Id: 'm1',
            MetricStat: {
                Metric: {
                    Namespace: 'AWS/SQS',
                    MetricName: 'ApproximateNumberOfMessagesVisible',
                    Dimensions: [{ Name: 'QueueName', Value: 'fills' }],
                },
                Period: 60,
                Stat: 'Maximum',
            },
            ReturnData: true,
        };
        await waitFor(() =>
            expect(JSON.parse(textOf('MetricDataQuery JSON'))).toEqual(query),
        );
        expect(textOf('SQL')).toBe(
            `SELECT * FROM cloudwatch('${JSON.stringify(query)}', \${ld.parameters.__from}, \${ld.parameters.__to})`,
        );
    });

    it('uses JSON edited by hand, such as a metric math expression', async () => {
        renderUi(<InvestigateEditor onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole('radio', { name: 'CloudWatch metrics' }));
        const expression = { Id: 'e1', Expression: 'm1 * 100', ReturnData: true };
        setText('MetricDataQuery JSON', JSON.stringify(expression, null, 2));
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                `SELECT * FROM cloudwatch('${JSON.stringify(expression)}', \${ld.parameters.__from}, \${ld.parameters.__to})`,
            ),
        );
    });

    it('builds Logs Insights SQL from log groups and a query', async () => {
        const onChange = vi.fn();
        renderUi(<InvestigateEditor onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name: 'CloudWatch Logs' }));
        setText('Log groups', '/aws/lambda/fills, /aws/lambda/refills');
        setText(
            'Logs Insights query',
            'fields @timestamp, @message | filter @message like /ERROR/',
        );
        await waitFor(() =>
            expect(textOf('SQL')).toBe(
                "SELECT * FROM cloudwatch_logs('/aws/lambda/fills,/aws/lambda/refills', 'fields @timestamp, @message | filter @message like /ERROR/', ${ld.parameters.__from}, ${ld.parameters.__to})",
            ),
        );
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: 'cloudwatch_logs' }),
        );
    });
});
