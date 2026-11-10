/* eslint-disable */
// @ts-nocheck
// imp-query-ops-marts: GitHub and Sentry targets read the BigQuery Ops Marts when a mart is
// mapped for their query type, and become a clear TODO (never broken SQL) when none is.
import { DATASOURCES, codes, loadGrafanaQuery } from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const github = {
    refId: 'A',
    datasource: { type: 'grafana-github-datasource', uid: 'betb591q7ij28b' },
    queryType: 'Pull_Requests',
    owner: 'houserx',
    repository: 'platform',
    options: { query: 'is:open base:staging draft:false', timeField: 3 },
};
const sentry = {
    refId: 'A',
    datasource: { type: 'grafana-sentry-datasource', uid: '2qa_JwISk' },
    queryType: 'statsV2',
    projectIds: ['1'],
    environments: ['production'],
    statsCategory: ['error'],
    statsFields: ['sum(quantity)'],
    statsOutcome: ['accepted'],
};

describe('GitHub and Sentry targets', () => {
    it('become a TODO with a no-ops-mart warning when no mart is mapped', () => {
        for (const target of [github, sentry]) {
            const result = q.translateGrafanaTarget(target, { datasources: DATASOURCES });
            expect(result.sql).toBeNull();
            expect(typeof result.todo).toBe('string');
            expect(result.todo).toMatch(/ops mart/i);
            expect(result.todo).toContain(target.queryType);
            expect(codes(result.warnings)).toContain('no-ops-mart');
        }
    });

    it('read the mapped Ops Mart table', () => {
        const opsMarts = {
            github: { Pull_Requests: 'ops_marts.github.pull_requests' },
            sentry: { statsV2: 'ops_marts.sentry.event_stats_daily' },
        };
        const pr = q.translateGrafanaTarget(github, { datasources: DATASOURCES, opsMarts });
        expect(pr.todo).toBeNull();
        expect(pr.sql).toMatch(/\bFROM\s+ops_marts\.github\.pull_requests\b/i);
        expect(codes(pr.warnings)).not.toContain('no-ops-mart');
        const stats = q.translateGrafanaTarget(sentry, { datasources: DATASOURCES, opsMarts });
        expect(stats.sql).toMatch(/\bFROM\s+ops_marts\.sentry\.event_stats_daily\b/i);
    });

    it('stays a TODO for a query type the mapping does not cover', () => {
        const result = q.translateGrafanaTarget(
            { ...github, queryType: 'Workflow_Usage' },
            {
                datasources: DATASOURCES,
                opsMarts: { github: { Pull_Requests: 'ops_marts.github.pull_requests' } },
            },
        );
        expect(result.sql).toBeNull();
        expect(result.todo).toContain('Workflow_Usage');
        expect(codes(result.warnings)).toContain('no-ops-mart');
    });
});
