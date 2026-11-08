/** Shared setup for InvestigateWorkspace acceptance tests. */
import { load } from './load';

export const noAccess = {
    telemetry_restricted: false,
    platform_read: false,
    platform_write: false,
    platform_explain: false,
};

export const metricResult = {
    columns: ['timestamp', 'value', 'labels', 'series'],
    rows: [
        {
            timestamp: '2026-11-08T10:00:00.000Z',
            value: 1,
            labels: '{"job":"api"}',
            series: '{job="api"}',
        },
    ],
};

export const loadWorkspace = async () =>
    (await load('../../features/investigate/components/InvestigateWorkspace'))
        .InvestigateWorkspace;
