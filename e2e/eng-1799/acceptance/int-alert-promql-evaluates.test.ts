/* eslint-disable */
// @ts-nocheck
// int-alert-promql-evaluates: an Alert Rule created through Lightdash's alerting API, whose SQL uses
// promql() with the reserved time parameters, is evaluated by one scheduler cycle through the real
// engine: the fake Prometheus is asked for the rule's window, the series fires, and the alerting
// state API lists the firing instance with its labels, value and rendered annotation.
import { RULE_SQL } from './fixtures';
import { disposeAll, harness, ld, track } from './support';

afterAll(disposeAll);

describe('int-alert-promql-evaluates', () => {
    it('evaluates through the engine and fires', async () => {
        const h = await harness();
        const prom = track(
            await h.startFakePrometheus({
                series: [
                    { labels: { __name__: 'db_cpu', instance: 'db-1' }, value: 95 },
                    { labels: { __name__: 'db_cpu', instance: 'db-2' }, value: 10 },
                ],
            }),
        );
        const engine = track(await h.startEngine({ prometheus: prom }));
        const lightdash = track(await h.startLightdash({ engine }));
        const base = `/api/v2/projects/${lightdash.projectUuid}/alerting`;

        const created = await ld(lightdash, 'POST', `${base}/rules`, {
            name: 'Synthetic DB CPU high',
            description: 'Synthetic database CPU above 90%',
            query: RULE_SQL(),
            reducer: 'last',
            condition: { operator: '>', threshold: 90 },
            for: '0s',
            interval: '30s',
            timeRange: '5m',
            labels: { team: 'infra' },
            annotations: { summary: '{{ $labels.instance }} CPU is {{ $value }}' },
        });
        expect(created.status, created.text).toBe(200);
        const ruleUuid = created.json.results.uuid;

        await lightdash.runAlertingCycle();

        const call = prom.requests.find((r) => r.path === '/api/v1/query_range' && r.params.query === 'db_cpu');
        expect(call).toBeDefined();
        expect(Number(call.params.end) - Number(call.params.start)).toBe(300);

        const rule = await ld(lightdash, 'GET', `${base}/rules/${ruleUuid}`);
        expect(rule.status).toBe(200);
        expect(rule.json.results.state).toBe('firing');
        const instances = rule.json.results.instances;
        const db1 = instances.find((i) => i.labels.instance === 'db-1');
        expect(db1).toMatchObject({ state: 'firing', value: 95 });
        expect(db1.labels).toMatchObject({ alertname: 'Synthetic DB CPU high', team: 'infra' });
        expect(db1.annotations.summary).toBe('db-1 CPU is 95');
        expect(instances.find((i) => i.labels.instance === 'db-2').state).toBe('normal');

        const state = await ld(lightdash, 'GET', `${base}/state`);
        expect(state.status).toBe(200);
        expect(state.json.results.instances.map((i) => [i.ruleUuid, i.labels.instance, i.state])).toEqual([[ruleUuid, 'db-1', 'firing']]);
    });
});
