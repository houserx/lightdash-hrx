/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// `lightdash download|upload --alerting-only` and `lightdash alerting shadow-report`.
import * as yaml from 'js-yaml';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    contactPointDoc,
    PROJECT_UUID,
    routesDoc,
    ruleDoc,
    runCli,
    slackDoc,
    startMockLightdash,
    tempDir,
} from './support';

const writeYaml = async (file: string, doc: unknown) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, yaml.dump(doc));
};

describe('alert-cli-download', () => {
    it('writes Alert Rules, Contact Points and the route tree as YAML', async () => {
        const api = await startMockLightdash((r) =>
            r.method === 'GET' &&
            r.path.split('?')[0] ===
                `/api/v2/projects/${PROJECT_UUID}/alerting/as-code`
                ? {
                      results: {
                          documents: [
                              ruleDoc,
                              contactPointDoc,
                              slackDoc,
                              routesDoc,
                          ],
                      },
                  }
                : undefined,
        );
        const { dir, cleanup } = await tempDir();
        try {
            const out = path.join(dir, 'out');
            const result = await runCli(
                [
                    'download',
                    '--alerting-only',
                    '--project',
                    PROJECT_UUID,
                    '--path',
                    out,
                ],
                api.url,
                dir,
            );
            expect(result.code, result.stderr).toBe(0);
            expect(api.alerting('/as-code', 'GET')).toHaveLength(1);
            const read = async (...parts: string[]) =>
                yaml.load(await readFile(path.join(out, ...parts), 'utf8'));
            expect(
                await read('alert-rules', 'rds-free-storage-low.yml'),
            ).toEqual(ruleDoc);
            expect(await read('contact-points', 'incident-io.yml')).toEqual(
                contactPointDoc,
            );
            expect(
                await read('contact-points', 'slack-infra-alerts.yml'),
            ).toEqual(slackDoc);
            expect(
                await read('notification-routes', 'notification-routes.yml'),
            ).toEqual(routesDoc);
            expect(
                api.requests.some(
                    (r) =>
                        r.path.includes('/charts') ||
                        r.path.includes('/dashboards'),
                ),
            ).toBe(false);
        } finally {
            await cleanup();
            await api.close();
        }
    });
});

describe('alert-cli-upload', () => {
    it('uploads Contact Points, then the route tree, then Alert Rules', async () => {
        const api = await startMockLightdash((r) =>
            r.method === 'POST' &&
            r.path.split('?')[0] ===
                `/api/v2/projects/${PROJECT_UUID}/alerting/as-code`
                ? { results: { created: 0, updated: 0 } }
                : undefined,
        );
        const { dir, cleanup } = await tempDir();
        try {
            const src = path.join(dir, 'lightdash');
            await writeYaml(
                path.join(src, 'alert-rules', 'rds-free-storage-low.yml'),
                ruleDoc,
            );
            await writeYaml(
                path.join(
                    src,
                    'notification-routes',
                    'notification-routes.yml',
                ),
                routesDoc,
            );
            await writeYaml(
                path.join(src, 'contact-points', 'incident-io.yml'),
                contactPointDoc,
            );
            await writeYaml(
                path.join(src, 'contact-points', 'slack-infra-alerts.yml'),
                slackDoc,
            );
            const result = await runCli(
                [
                    'upload',
                    '--alerting-only',
                    '--project',
                    PROJECT_UUID,
                    '--path',
                    src,
                ],
                api.url,
                dir,
            );
            expect(result.code, result.stderr).toBe(0);
            const posts = api.alerting('/as-code', 'POST');
            expect(posts.length).toBeGreaterThan(0);
            const sent = posts.flatMap((p) => p.body.documents);
            expect(sent).toHaveLength(4);
            const order = sent.map((d: any) => d.type);
            expect(order.lastIndexOf('contact_point')).toBeLessThan(
                order.indexOf('notification_routes'),
            );
            expect(order.indexOf('notification_routes')).toBeLessThan(
                order.indexOf('alert_rule'),
            );
            expect(sent.find((d: any) => d.type === 'alert_rule')).toEqual(
                ruleDoc,
            );
            expect(sent.find((d: any) => d.slug === 'incident-io')).toEqual(
                contactPointDoc,
            );
        } finally {
            await cleanup();
            await api.close();
        }
    });
});

describe('alert-cli-upload-validation', () => {
    it('refuses to upload an inlined secret and names the file', async () => {
        const api = await startMockLightdash();
        const { dir, cleanup } = await tempDir();
        try {
            const src = path.join(dir, 'lightdash');
            await writeYaml(path.join(src, 'contact-points', 'leaky.yml'), {
                ...slackDoc,
                slug: 'leaky',
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: 'https://hooks.slack.com/services/T0/B0/test-secret-not-real',
                    },
                ],
            });
            await writeYaml(
                path.join(src, 'alert-rules', 'rds-free-storage-low.yml'),
                ruleDoc,
            );
            const result = await runCli(
                [
                    'upload',
                    '--alerting-only',
                    '--project',
                    PROJECT_UUID,
                    '--path',
                    src,
                ],
                api.url,
                dir,
            );
            expect(result.code).not.toBe(0);
            const output = `${result.stdout}\n${result.stderr}`;
            expect(output).toContain('leaky.yml');
            expect(output).toMatch(/secretRef/);
            expect(api.alerting('/as-code', 'POST')).toHaveLength(0);
        } finally {
            await cleanup();
            await api.close();
        }
    });
});

describe('alert-cli-shadow-report', () => {
    it('posts the Grafana history and expected differences and prints the comparison', async () => {
        let unexpectedCount = 1;
        const api = await startMockLightdash((r) =>
            r.method === 'POST' &&
            r.path.split('?')[0] ===
                `/api/v2/projects/${PROJECT_UUID}/alerting/shadow-report`
                ? {
                      results: {
                          matched: [
                              {
                                  ruleName: 'pg_cron job failed',
                                  grafanaAt: '2026-11-08T09:01:00Z',
                                  lightdashAt: '2026-11-08T09:00:00Z',
                              },
                          ],
                          missingInLightdash:
                              unexpectedCount > 0
                                  ? [
                                        {
                                            ruleName: 'ALB Unhealthy Hosts',
                                            at: '2026-11-08T09:30:00Z',
                                            labels: {},
                                            expected: false,
                                        },
                                    ]
                                  : [],
                          extraInLightdash: [],
                          unexpectedCount,
                      },
                  }
                : undefined,
        );
        const { dir, cleanup } = await tempDir();
        try {
            const history = {
                schema: {
                    fields: [
                        { name: 'time' },
                        { name: 'line' },
                        { name: 'labels' },
                    ],
                },
                data: { values: [[], [], []] },
            };
            await writeFile(
                path.join(dir, 'history.json'),
                JSON.stringify(history),
            );
            const expected = [
                {
                    ruleName: 'Security group changed',
                    kind: 'missing_in_lightdash',
                    reason: 'slack-sec receives nothing today',
                },
            ];
            await writeFile(
                path.join(dir, 'expected.yml'),
                yaml.dump(expected),
            );
            const args = [
                'alerting',
                'shadow-report',
                '--project',
                PROJECT_UUID,
                '--since',
                '2026-11-01T00:00:00Z',
                '--grafana-history',
                path.join(dir, 'history.json'),
                '--expected-differences',
                path.join(dir, 'expected.yml'),
            ];
            const json = await runCli([...args, '--json'], api.url, dir);
            expect(json.code, json.stderr).toBe(0);
            const [post] = api.alerting('/shadow-report', 'POST');
            expect(post.body).toEqual({
                since: '2026-11-01T00:00:00Z',
                grafanaHistory: history,
                expectedDifferences: expected,
            });
            expect(JSON.parse(json.stdout)).toMatchObject({
                unexpectedCount: 1,
                matched: [{ ruleName: 'pg_cron job failed' }],
            });

            const human = await runCli(args, api.url, dir);
            expect(human.code).toBe(0);
            expect(human.stdout).toContain('ALB Unhealthy Hosts');
            expect(human.stdout).toContain('pg_cron job failed');

            const failing = await runCli(
                [...args, '--fail-on-unexpected'],
                api.url,
                dir,
            );
            expect(failing.code).toBe(1);
            unexpectedCount = 0;
            const passing = await runCli(
                [...args, '--fail-on-unexpected'],
                api.url,
                dir,
            );
            expect(passing.code, passing.stderr).toBe(0);
        } finally {
            await cleanup();
            await api.close();
        }
    });
});
