/* eslint-disable */
// @ts-nocheck
// imp-alert-rule-fields: each Grafana rule becomes an alert_rule document carrying its name,
// folder (space), for, labels, annotations, no-data and error states, paused flag, group
// interval and query window, always with shadow: true for the Shadow Run.
import { importSynthetic, policy, promData, reduceThreshold, rule, ruleGroup } from './alertsupport';
import { expectValidAlerting, generateSlug } from './support';

const RULES = ruleGroup(
    'api_alerts',
    [
        rule({
            name: 'API 5xx ratio high',
            for: '10m',
            data: promData('A', 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))', 900) + reduceThreshold('A', 'gt', 0.05),
            labels: { team: 'infra', severity: '2' },
            annotations: { summary: 'API 5xx ratio above 5%', runbook_url: 'https://example.test/runbook' },
            noData: 'OK',
            execErr: 'Alerting',
            paused: true,
        }),
        rule({ name: 'Keep last', data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), noData: 'KeepLast', execErr: 'KeepLast', annotations: { summary: 'Keeps the last state' } }),
        rule({ name: 'Alerting on no data', data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), noData: 'Alerting', execErr: 'Error', annotations: { summary: 'Fires on no data' } }),
        rule({ name: 'Error is OK', data: promData('A', 'up') + reduceThreshold('A', 'lt', 1), noData: 'NoData', execErr: 'OK', annotations: { summary: 'Errors count as OK' } }),
    ],
    { folder: 'Service Mesh', interval: 120 },
);

let run: any;
beforeAll(async () => {
    run = await importSynthetic(RULES, policy(''));
});
afterAll(() => run?.cleanup());

const byName = (name) => run.alertRules().map((r) => r.doc).find((d) => d.name === name);

describe('alert rule fields', () => {
    it('carries the rule definition', () => {
        const doc = byName('API 5xx ratio high');
        expectValidAlerting(doc);
        expect(doc).toMatchObject({
            version: 1,
            type: 'alert_rule',
            slug: generateSlug('API 5xx ratio high'),
            spaceSlug: generateSlug('Service Mesh'),
            for: '10m',
            interval: '2m',
            timeRange: '15m',
            labels: { team: 'infra', severity: '2' },
            noDataState: 'normal',
            errorState: 'alerting',
            paused: true,
            shadow: true,
        });
        expect(doc.annotations).toMatchObject({
            summary: 'API 5xx ratio above 5%',
            runbook_url: 'https://example.test/runbook',
        });
    });

    it('maps every no-data and error state', () => {
        expect(byName('Keep last')).toMatchObject({ noDataState: 'keep_last', errorState: 'keep_last' });
        expect(byName('Alerting on no data')).toMatchObject({ noDataState: 'alerting', errorState: 'error' });
        expect(byName('Error is OK').noDataState).toBe('nodata');
        // Lightdash has no "normal" error state: the closest is kept, with a warning.
        expect(['keep_last', 'error']).toContain(byName('Error is OK').errorState);
        expect(run.text('IMPORT-REPORT.md')).toContain('Error is OK');
    });

    it('emits every rule in shadow mode, valid', () => {
        for (const { doc } of run.alertRules()) {
            expect(doc.shadow).toBe(true);
            expectValidAlerting(doc);
        }
    });
});
