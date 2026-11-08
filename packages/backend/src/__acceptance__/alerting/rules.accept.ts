/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Alert Rule CRUD, validation, versions and permissions over the HTTP API.
import { describe, expect, it } from 'vitest';
import { ruleInput, withHarness } from './support/harness';

describe('alert-rule-crud', () => {
    it('creates, reads, lists, updates and deletes Alert Rules with documented defaults', () =>
        withHarness(async (h) => {
            const created = await h.ok(
                h
                    .api('editor')
                    .post(
                        '/rules',
                        ruleInput({ spaceUuid: h.spaces.platform.uuid }),
                    ),
            );
            expect(created).toMatchObject({
                projectUuid: h.projectUuid,
                spaceUuid: h.spaces.platform.uuid,
                slug: 'disk-almost-full',
                name: 'Disk almost full',
                description: 'Disk usage on a database host is above 90%',
                labels: { team: 'infra' },
                annotations: { summary: 'Disk almost full' },
                reducer: 'last',
                condition: { operator: '>', threshold: 90 },
                for: '0s',
                keepFiringFor: '0s',
                interval: '1m',
                timeRange: '10m',
                valueColumn: 'value',
                noDataState: 'nodata',
                errorState: 'error',
                paused: false,
                shadow: false,
                managed: false,
                version: 1,
            });
            expect(created.uuid).toMatch(/^[0-9a-f-]{36}$/);

            const read = await h.ok(
                h.api('viewer').get(`/rules/${created.uuid}`),
            );
            expect(read).toMatchObject({
                uuid: created.uuid,
                state: 'normal',
                instances: [],
            });

            const list = await h.ok(h.api('viewer').get('/rules'));
            expect(list.map((r: any) => r.uuid)).toEqual([created.uuid]);

            const second = await h.ok(
                h.api('editor').post('/rules', ruleInput()),
            );
            expect(second.slug).not.toBe(created.slug);

            const updated = await h.ok(
                h.api('editor').patch(`/rules/${created.uuid}`, {
                    condition: { operator: '>=', threshold: 95 },
                }),
            );
            expect(updated).toMatchObject({
                uuid: created.uuid,
                version: 2,
                condition: { operator: '>=', threshold: 95 },
                description: 'Disk usage on a database host is above 90%',
            });

            expect(
                (await h.api('editor').delete(`/rules/${created.uuid}`)).status,
            ).toBe(200);
            expect(
                (await h.api('viewer').get(`/rules/${created.uuid}`)).status,
            ).toBe(404);

            await h
                .db('projects')
                .where({ project_uuid: h.projectUuid })
                .delete();
            const [{ count }] = await h
                .db('alert_rules')
                .where({ project_uuid: h.projectUuid })
                .count('* as count');
            expect(Number(count)).toBe(0);
        }));
});

describe('alert-rule-validation', () => {
    it('refuses invalid Alert Rules with a 400', () =>
        withHarness(async (h) => {
            const bad = async (input: Record<string, unknown>) => {
                const r = await h.api('editor').post('/rules', input);
                expect(r.status, JSON.stringify(input)).toBe(400);
                expect(r.body?.status).toBe('error');
                return r;
            };
            const { description: _d, ...noDescription } = ruleInput();
            const missing = await bad(noDescription);
            expect(JSON.stringify(missing.body)).toMatch(/description/i);
            await bad(ruleInput({ description: '   ' }));
            await bad(ruleInput({ name: '' }));
            await bad(ruleInput({ query: '' }));
            await bad(ruleInput({ interval: '15s' }));
            await bad(ruleInput({ interval: 'soon' }));
            await bad(ruleInput({ for: 'abc' }));
            await bad(ruleInput({ keepFiringFor: '-1m' }));
            await bad(ruleInput({ reducer: 'median' }));
            await bad(
                ruleInput({ condition: { operator: '=>', threshold: 1 } }),
            );
            await bad(
                ruleInput({ condition: { operator: '>', threshold: 'high' } }),
            );
            await bad(
                ruleInput({
                    condition: { operator: 'within_range', min: 20, max: 10 },
                }),
            );
            await bad(ruleInput({ noDataState: 'ok' }));
            await bad(ruleInput({ errorState: 'nodata' }));
            await bad(
                ruleInput({
                    spaceUuid: '00000000-0000-4000-8000-000000000000',
                }),
            );

            for (const noDataState of [
                'nodata',
                'normal',
                'alerting',
                'keep_last',
            ])
                for (const errorState of ['error', 'alerting', 'keep_last'])
                    await h.ok(
                        h.api('editor').post(
                            '/rules',
                            ruleInput({
                                name: `r ${noDataState} ${errorState}`,
                                noDataState,
                                errorState,
                            }),
                        ),
                    );
            const edge = await h.ok(
                h.api('editor').post(
                    '/rules',
                    ruleInput({
                        name: 'thirty seconds',
                        interval: '30s',
                        for: '5m',
                        keepFiringFor: '10m',
                        condition: {
                            operator: 'outside_range',
                            min: 10,
                            max: 20,
                        },
                    }),
                ),
            );
            expect(edge.interval).toBe('30s');
            const patch = await h
                .api('editor')
                .patch(`/rules/${edge.uuid}`, { interval: '10s' });
            expect(patch.status).toBe(400);
            expect(
                (await h.ok(h.api('viewer').get(`/rules/${edge.uuid}`)))
                    .interval,
            ).toBe('30s');
        }));
});

describe('alert-rule-versions', () => {
    it('keeps every change as a listable version', () =>
        withHarness(async (h) => {
            const rule = await h.ok(
                h.api('editor').post('/rules', ruleInput()),
            );
            await h.ok(
                h.api('editor').patch(`/rules/${rule.uuid}`, {
                    query: 'SELECT instance, value FROM disk_usage_v2',
                }),
            );
            await h.ok(
                h.api('developer').patch(`/rules/${rule.uuid}`, {
                    description: 'Disk above 90% on any db host',
                }),
            );
            const versions = await h.ok(
                h.api('viewer').get(`/rules/${rule.uuid}/versions`),
            );
            expect(versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
            expect(versions[2].rule).toMatchObject({
                query: 'SELECT instance, value FROM disk_usage',
                description: 'Disk usage on a database host is above 90%',
            });
            expect(versions[1].rule).toMatchObject({
                query: 'SELECT instance, value FROM disk_usage_v2',
            });
            expect(versions[0].rule).toMatchObject({
                description: 'Disk above 90% on any db host',
            });
            expect(versions[2].createdByUserUuid).toBe(h.users.editor.userUuid);
            expect(versions[0].createdByUserUuid).toBe(
                h.users.developer.userUuid,
            );
            expect(typeof versions[0].createdAt).toBe('string');
        }));
});

describe('alert-rule-permissions', () => {
    it('lets viewers read, editors and above change, and nobody else', () =>
        withHarness(async (h) => {
            const rule = await h.ok(
                h.api('editor').post('/rules', ruleInput()),
            );
            expect((await h.api('viewer').get('/rules')).status).toBe(200);
            expect(
                (await h.api('viewer').get(`/rules/${rule.uuid}`)).status,
            ).toBe(200);
            expect(
                (await h.api('viewer').post('/rules', ruleInput({ name: 'v' })))
                    .status,
            ).toBe(403);
            expect(
                (
                    await h
                        .api('interactive_viewer')
                        .post('/rules', ruleInput({ name: 'iv' }))
                ).status,
            ).toBe(403);
            expect(
                (
                    await h
                        .api('viewer')
                        .patch(`/rules/${rule.uuid}`, { paused: true })
                ).status,
            ).toBe(403);
            expect(
                (await h.api('viewer').delete(`/rules/${rule.uuid}`)).status,
            ).toBe(403);
            const paused = await h.ok(
                h.api('editor').patch(`/rules/${rule.uuid}`, { paused: true }),
            );
            expect(paused.paused).toBe(true);
            await h.ok(
                h
                    .api('developer')
                    .patch(`/rules/${rule.uuid}`, { paused: false }),
            );
            await h.ok(
                h
                    .api('admin')
                    .patch(`/rules/${rule.uuid}`, { labels: { team: 'db' } }),
            );
            expect((await h.api('outsider').get('/rules')).status).toBe(403);
            expect(
                (await h.api('outsider').get(`/rules/${rule.uuid}`)).status,
            ).toBe(403);
            expect(
                (
                    await h
                        .api('outsider')
                        .post('/rules', ruleInput({ name: 'o' }))
                ).status,
            ).toBe(403);
            expect(
                (await h.api('outsider').delete(`/rules/${rule.uuid}`)).status,
            ).toBe(403);
            expect((await h.api(null).get('/rules')).status).toBe(401);
            const [{ count }] = await h.db('alert_rules').count('* as count');
            expect(Number(count)).toBe(1);
        }));
});
