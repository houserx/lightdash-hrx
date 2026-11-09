/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// The evaluator: query identity, per-series state, for / keepFiringFor,
// state history, paused, no data, errors, list filters and preview.
import { describe, expect, it } from 'vitest';
import {
    disk,
    minutes,
    ruleInput,
    T0,
    withHarness,
    type Harness,
} from './support/harness';

const at = (m: number) => new Date(T0.getTime() + minutes(m));

/** Evaluates `ruleUuid` at minute `m` with the given disk values. */
const step = async (
    h: Harness,
    ruleUuid: string,
    m: number,
    values: Record<string, number>,
) => {
    h.clock.set(at(m));
    h.warehouse.rows(disk(values));
    return h.evaluate(ruleUuid, at(m));
};

const transitions = async (h: Harness, ruleUuid: string, query = '') => {
    const history = await h.ok(
        h.api('viewer').get(`/rules/${ruleUuid}/history${query}`),
    );
    return (history as any[]).filter((e) => e.type === 'transition');
};

describe('alert-eval-query-identity', () => {
    it('queries the WarehouseClient as system:alert-evaluator with time parameters resolved', () =>
        withHarness(async (h) => {
            const rule = await h.createRule({
                description:
                    'Pages when a db disk passes 90% (ENG-1799 acceptance)',
                timeRange: '7d',
                query: "SELECT instance, value FROM disk WHERE ts >= '${ld.parameters.__from}' AND ts < '${ld.parameters.__to}' AND step = '${ld.parameters.__interval}'",
            });
            h.warehouse.rows(disk({ 'db-1': 50 }));
            const outcome = await h.evaluate(rule.uuid, T0);
            expect(outcome.status).toBe('evaluated');
            expect(h.warehouse.calls).toHaveLength(1);
            const [call] = h.warehouse.calls;
            expect(call.projectUuid).toBe(h.projectUuid);
            expect(call.context).toMatchObject({
                sub: 'system:alert-evaluator',
                sys: true,
                agent: false,
                projectUuid: h.projectUuid,
                audit: {
                    description:
                        'Pages when a db disk passes 90% (ENG-1799 acceptance)',
                    source: 'alert_rule',
                    resource_uuid: rule.uuid,
                },
            });
            expect(call.sql).not.toContain('${ld.parameters');
            expect(call.sql).toMatch(/ts >= '2026-11-01T09:00:00(\.000)?Z'/);
            expect(call.sql).toMatch(/ts < '2026-11-08T09:00:00(\.000)?Z'/);
            expect(call.sql).toContain("step = '15m'");
        }));
});

describe('alert-eval-series-states', () => {
    it('gives every series its own state, stored per series', () =>
        withHarness(async (h) => {
            const rule = await h.createRule();
            await step(h, rule.uuid, 0, { 'db-1': 95, 'db-2': 40, 'db-3': 99 });
            const read = await h.getRule(rule.uuid);
            expect(read.state).toBe('firing');
            expect(read.instances).toHaveLength(3);
            const db1 = await h.instance(rule.uuid, { instance: 'db-1' });
            expect(db1).toMatchObject({
                state: 'firing',
                value: 95,
                labels: {
                    instance: 'db-1',
                    team: 'infra',
                    alertname: 'Disk almost full',
                },
            });
            expect(db1.fingerprint).toMatch(/^[0-9a-f]{16}$/);
            expect(new Date(db1.since).toISOString()).toBe(T0.toISOString());
            expect(
                await h.instance(rule.uuid, { instance: 'db-2' }),
            ).toMatchObject({ state: 'normal', value: 40 });
            expect(
                await h.instance(rule.uuid, { instance: 'db-3' }),
            ).toMatchObject({ state: 'firing', value: 99 });
            const [{ count }] = await h
                .db('alert_instances')
                .count('* as count');
            expect(Number(count)).toBe(3);
        }));
});

describe('alert-eval-for-pending', () => {
    it('goes pending and fires only after `for`', () =>
        withHarness(async (h) => {
            const rule = await h.createRule({ for: '2m' });
            const seen: string[] = [];
            for (const m of [0, 1, 2, 3]) {
                await step(h, rule.uuid, m, {
                    'db-1': 95,
                    'db-2': m === 0 ? 95 : 10,
                });
                seen.push(
                    (await h.instance(rule.uuid, { instance: 'db-1' })).state,
                );
                if (m === 0)
                    expect((await h.getRule(rule.uuid)).state).toBe('pending');
                if (m === 1)
                    expect(
                        (await h.instance(rule.uuid, { instance: 'db-2' }))
                            .state,
                    ).toBe('normal');
            }
            expect(seen).toEqual(['pending', 'pending', 'firing', 'firing']);
            expect((await h.getRule(rule.uuid)).state).toBe('firing');
        }));
});

describe('alert-eval-keep-firing-for', () => {
    it('keeps a recovered series firing for keepFiringFor', () =>
        withHarness(async (h) => {
            const rule = await h.createRule({ keepFiringFor: '2m' });
            const seen: string[] = [];
            for (const [m, v] of [
                [0, 95],
                [1, 10],
                [2, 10],
                [3, 10],
            ] as const) {
                await step(h, rule.uuid, m, { 'db-1': v });
                seen.push(
                    (await h.instance(rule.uuid, { instance: 'db-1' })).state,
                );
            }
            expect(seen).toEqual(['firing', 'firing', 'resolved', 'normal']);
        }));
});

describe('alert-eval-state-history', () => {
    it('writes every transition with previous state, new state, value and time', () =>
        withHarness(async (h) => {
            const rule = await h.createRule();
            for (const [m, v] of [
                [0, 95],
                [1, 96],
                [2, 10],
                [3, 10],
                [4, 10],
            ] as const)
                await step(h, rule.uuid, m, { 'db-1': v });
            const entries = await transitions(h, rule.uuid);
            expect(
                entries.map((e: any) => [
                    e.previousState,
                    e.state,
                    e.value,
                    new Date(e.at).toISOString(),
                ]),
            ).toEqual([
                ['resolved', 'normal', 10, at(3).toISOString()],
                ['firing', 'resolved', 10, at(2).toISOString()],
                ['normal', 'firing', 95, at(0).toISOString()],
            ]);
            expect(entries[0]).toMatchObject({
                ruleUuid: rule.uuid,
                labels: { instance: 'db-1', alertname: 'Disk almost full' },
            });
            expect(entries[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
            const [{ count }] = await h
                .db('alert_state_history')
                .count('* as count');
            expect(Number(count)).toBeGreaterThanOrEqual(3);
        }));
});

describe('alert-eval-paused', () => {
    it('skips paused rules without querying', () =>
        withHarness(async (h) => {
            const rule = await h.createRule({ paused: true });
            h.warehouse.rows(disk({ 'db-1': 95 }));
            expect(await h.evaluate(rule.uuid, T0)).toMatchObject({
                status: 'skipped',
                reason: 'paused',
            });
            expect(h.warehouse.calls).toHaveLength(0);
            expect((await h.getRule(rule.uuid)).instances).toEqual([]);
            await h.ok(
                h.api('editor').patch(`/rules/${rule.uuid}`, { paused: false }),
            );
            h.clock.set(at(1));
            expect(await h.evaluate(rule.uuid, at(1))).toMatchObject({
                status: 'evaluated',
            });
            expect(h.warehouse.calls).toHaveLength(1);
        }));
});

const noDataOrErrorCase = async (
    h: Harness,
    field: 'noDataState' | 'errorState',
    value: string,
    breakIt: () => void,
) => {
    const rule = await h.createRule({
        name: `${field} ${value}`,
        [field]: value,
    });
    await step(h, rule.uuid, 0, { 'db-1': 95 });
    expect((await h.instance(rule.uuid, { instance: 'db-1' })).state).toBe(
        'firing',
    );
    h.clock.set(at(1));
    breakIt();
    await h.evaluate(rule.uuid, at(1));
    return rule;
};

describe('alert-eval-nodata', () => {
    it('follows noDataState on an empty result', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', { groupWait: '0s' });
            const empty = () => h.warehouse.rows([]);

            const nodata = await noDataOrErrorCase(
                h,
                'noDataState',
                'nodata',
                empty,
            );
            const synthetic = await h.instance(nodata.uuid, {
                alertname: 'DatasourceNoData',
            });
            expect(synthetic).toMatchObject({
                state: 'nodata',
                labels: { rulename: nodata.name },
            });
            expect((await h.getRule(nodata.uuid)).state).toBe('nodata');
            await h.module.notifier.flush();
            const sent = h.outbound.to('/hooks/ops').map((r) => r.json);
            expect(
                sent.some((p) =>
                    p.alerts.some(
                        (a: any) =>
                            a.labels.alertname === 'DatasourceNoData' &&
                            a.status === 'firing',
                    ),
                ),
            ).toBe(true);

            const normal = await noDataOrErrorCase(
                h,
                'noDataState',
                'normal',
                empty,
            );
            expect(
                (await h.instance(normal.uuid, { instance: 'db-1' })).state,
            ).toBe('resolved');
            expect(
                await h.instance(normal.uuid, {
                    alertname: 'DatasourceNoData',
                }),
            ).toBeUndefined();

            const alerting = await noDataOrErrorCase(
                h,
                'noDataState',
                'alerting',
                empty,
            );
            expect(
                (
                    await h.instance(alerting.uuid, {
                        alertname: 'DatasourceNoData',
                    })
                ).state,
            ).toBe('firing');

            const keep = await noDataOrErrorCase(
                h,
                'noDataState',
                'keep_last',
                empty,
            );
            expect(
                (await h.instance(keep.uuid, { instance: 'db-1' })).state,
            ).toBe('firing');
            expect(
                await h.instance(keep.uuid, { alertname: 'DatasourceNoData' }),
            ).toBeUndefined();

            await step(h, nodata.uuid, 2, { 'db-1': 95 });
            expect(['nodata', 'firing', 'pending']).not.toContain(
                (
                    await h.instance(nodata.uuid, {
                        alertname: 'DatasourceNoData',
                    })
                )?.state,
            );
        }));
});

describe('alert-eval-error', () => {
    it('follows errorState when the source is unreachable, and clears on recovery', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', { groupWait: '0s' });
            const down = () =>
                h.warehouse.fail('connect ECONNREFUSED 127.0.0.1:5433');

            const error = await noDataOrErrorCase(
                h,
                'errorState',
                'error',
                down,
            );
            const synthetic = await h.instance(error.uuid, {
                alertname: 'DatasourceError',
            });
            expect(synthetic).toMatchObject({
                state: 'error',
                labels: { rulename: error.name },
            });
            expect(synthetic.annotations.error).toContain('ECONNREFUSED');
            expect((await h.getRule(error.uuid)).state).toBe('error');
            await h.module.notifier.flush();
            expect(
                h.outbound
                    .to('/hooks/ops')
                    .some((r) =>
                        r.json.alerts.some(
                            (a: any) =>
                                a.labels.alertname === 'DatasourceError',
                        ),
                    ),
            ).toBe(true);

            const alerting = await noDataOrErrorCase(
                h,
                'errorState',
                'alerting',
                down,
            );
            expect(
                (
                    await h.instance(alerting.uuid, {
                        alertname: 'DatasourceError',
                    })
                ).state,
            ).toBe('firing');

            const keep = await noDataOrErrorCase(
                h,
                'errorState',
                'keep_last',
                down,
            );
            expect(
                (await h.instance(keep.uuid, { instance: 'db-1' })).state,
            ).toBe('firing');
            expect(
                await h.instance(keep.uuid, { alertname: 'DatasourceError' }),
            ).toBeUndefined();

            await step(h, error.uuid, 2, { 'db-1': 95 });
            const state = await h.ok(h.api('viewer').get('/state'));
            expect(
                state.instances.filter(
                    (i: any) =>
                        i.ruleUuid === error.uuid &&
                        i.labels.alertname === 'DatasourceError',
                ),
            ).toEqual([]);
            expect(['error', 'firing']).not.toContain(
                (await h.instance(error.uuid, { alertname: 'DatasourceError' }))
                    ?.state,
            );
        }));
});

describe('alert-rule-list-filters', () => {
    it('lists rules with their state and filters by state, label and folder', () =>
        withHarness(async (h) => {
            const a = await h.createRule({
                name: 'A firing',
                spaceUuid: h.spaces.platform.uuid,
                labels: { team: 'infra' },
            });
            const b = await h.createRule({
                name: 'B pending',
                spaceUuid: h.spaces.rds.uuid,
                labels: { team: 'db' },
                for: '5m',
            });
            const c = await h.createRule({
                name: 'C quiet',
                labels: { team: 'infra' },
            });
            await step(h, a.uuid, 0, { 'db-1': 95 });
            await step(h, b.uuid, 0, { 'db-1': 95 });
            const all = await h.ok(h.api('viewer').get('/rules'));
            const stateOf = Object.fromEntries(
                all.map((r: any) => [r.name, r.state]),
            );
            expect(stateOf).toEqual({
                'A firing': 'firing',
                'B pending': 'pending',
                'C quiet': 'normal',
            });
            const names = async (q: string) =>
                (await h.ok(h.api('viewer').get(`/rules?${q}`)))
                    .map((r: any) => r.uuid)
                    .sort();
            expect(await names('state=firing')).toEqual([a.uuid]);
            expect(await names('state=pending')).toEqual([b.uuid]);
            expect(
                await names(`label=${encodeURIComponent('team=infra')}`),
            ).toEqual([a.uuid, c.uuid].sort());
            expect(await names(`spaceUuid=${h.spaces.rds.uuid}`)).toEqual([
                b.uuid,
            ]);
            expect(
                await names(
                    `state=normal&label=${encodeURIComponent('team=infra')}`,
                ),
            ).toEqual([c.uuid]);
        }));
});

describe('alert-rule-preview', () => {
    it('runs the query once and returns per-series results and the would-be state, saving nothing', () =>
        withHarness(async (h) => {
            h.warehouse.rows(disk({ 'db-1': 95, 'db-2': 40 }));
            const preview = await h.ok(
                h.api('editor').post('/rules/preview', ruleInput()),
            );
            expect(preview.error).toBeNull();
            const byInstance = Object.fromEntries(
                preview.series.map((s: any) => [s.labels.instance, s]),
            );
            expect(byInstance['db-1']).toMatchObject({
                value: 95,
                conditionMet: true,
                state: 'firing',
            });
            expect(byInstance['db-2']).toMatchObject({
                value: 40,
                conditionMet: false,
                state: 'normal',
            });
            expect(h.warehouse.calls).toHaveLength(1);
            const pending = await h.ok(
                h
                    .api('editor')
                    .post('/rules/preview', ruleInput({ for: '5m' })),
            );
            expect(
                pending.series.find((s: any) => s.labels.instance === 'db-1')
                    .state,
            ).toBe('pending');
            h.warehouse.fail('relation "disk_usage" does not exist');
            const failed = await h.ok(
                h.api('editor').post('/rules/preview', ruleInput()),
            );
            expect(failed.error).toContain('disk_usage');
            expect(failed.series).toEqual([]);
            const [{ count }] = await h.db('alert_rules').count('* as count');
            expect(Number(count)).toBe(0);
            const [{ count: instances }] = await h
                .db('alert_instances')
                .count('* as count');
            expect(Number(instances)).toBe(0);
            expect(
                (await h.api('viewer').post('/rules/preview', ruleInput()))
                    .status,
            ).toBe(403);
            expect(
                (
                    await h
                        .api('editor')
                        .post('/rules/preview', ruleInput({ description: '' }))
                ).status,
            ).toBe(400);
        }));
});

describe('alert-annotation-templates', () => {
    it('renders $labels and $value in annotations per series, like Grafana', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', { groupWait: '0s' });
            const rule = await h.createRule({
                annotations: {
                    summary: 'Disk on {{ $labels.instance }} is {{ $value }}%',
                    description:
                        '{{ if gt $value 98.0 }}critical{{ else }}warning{{ end }} for {{ $labels.team }}',
                    runbook_url: 'https://runbooks.example.test/disk',
                },
            });
            await step(h, rule.uuid, 0, { 'db-1': 95, 'db-3': 99 });
            expect(
                (await h.instance(rule.uuid, { instance: 'db-1' })).annotations,
            ).toMatchObject({
                summary: 'Disk on db-1 is 95%',
                description: 'warning for infra',
                runbook_url: 'https://runbooks.example.test/disk',
            });
            expect(
                (await h.instance(rule.uuid, { instance: 'db-3' })).annotations
                    .description,
            ).toBe('critical for infra');
            await h.module.notifier.flush();
            const alerts = h.outbound
                .to('/hooks/ops')
                .flatMap((r) => r.json.alerts);
            expect(
                alerts.map((a: any) => a.annotations.summary).sort(),
            ).toEqual(['Disk on db-1 is 95%', 'Disk on db-3 is 99%']);
            const state = await h.ok(h.api('viewer').get('/state'));
            expect(
                state.instances.map((i: any) => i.annotations.summary).sort(),
            ).toEqual(['Disk on db-1 is 95%', 'Disk on db-3 is 99%']);
        }));
});
