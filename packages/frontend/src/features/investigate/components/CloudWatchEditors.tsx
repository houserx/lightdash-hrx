import { Group, Stack, Textarea, TextInput } from '@mantine/core';
import { type ChangeEvent, type FC } from 'react';
import { type CloudWatchFormValues } from '../utils/cloudWatchForm';

type MetricsProps = {
    form: CloudWatchFormValues;
    onFormChange: (form: CloudWatchFormValues) => void;
    json: string;
    jsonError: string | undefined;
    onJsonChange: (json: string) => void;
};

/**
 * CloudWatch metrics: a form for a single metric stat, and the MetricDataQuery JSON it builds.
 * The JSON can be edited by hand, e.g. for a metric math expression.
 */
export const CloudWatchMetricsEditor: FC<MetricsProps> = ({
    form,
    onFormChange,
    json,
    jsonError,
    onJsonChange,
}) => {
    const field =
        (key: keyof CloudWatchFormValues) =>
        (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onFormChange({ ...form, [key]: event.currentTarget.value });
    return (
        <Stack gap="xs">
            <Group grow align="flex-start">
                <TextInput
                    label="Namespace"
                    placeholder="AWS/SQS"
                    value={form.namespace}
                    onChange={field('namespace')}
                />
                <TextInput
                    label="Metric name"
                    placeholder="ApproximateNumberOfMessagesVisible"
                    value={form.metricName}
                    onChange={field('metricName')}
                />
            </Group>
            <TextInput
                label="Dimensions"
                description="Name=Value pairs, separated by commas"
                placeholder="QueueName=fills"
                value={form.dimensions}
                onChange={field('dimensions')}
            />
            <Group grow align="flex-start">
                <TextInput
                    label="Statistic"
                    description="e.g. Average, Sum, Maximum, p99"
                    value={form.stat}
                    onChange={field('stat')}
                />
                <TextInput
                    label="Period"
                    description="Seconds"
                    inputMode="numeric"
                    value={form.period}
                    onChange={field('period')}
                />
            </Group>
            <Textarea
                label="MetricDataQuery JSON"
                description="Filled in from the form. Edit it by hand for metric math or SEARCH expressions."
                autosize
                minRows={4}
                ff="monospace"
                value={json}
                error={jsonError}
                onChange={(event) => onJsonChange(event.currentTarget.value)}
            />
        </Stack>
    );
};

type LogsProps = {
    logGroups: string;
    onLogGroupsChange: (logGroups: string) => void;
    query: string;
    onQueryChange: (query: string) => void;
};

/** CloudWatch Logs Insights: comma-separated log groups and a query. */
export const CloudWatchLogsEditor: FC<LogsProps> = ({
    logGroups,
    onLogGroupsChange,
    query,
    onQueryChange,
}) => (
    <Stack gap="xs">
        <TextInput
            label="Log groups"
            description="Separate log groups with commas"
            placeholder="/aws/lambda/fills"
            value={logGroups}
            onChange={(event) => onLogGroupsChange(event.currentTarget.value)}
        />
        <Textarea
            label="Logs Insights query"
            autosize
            minRows={2}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
    </Stack>
);
