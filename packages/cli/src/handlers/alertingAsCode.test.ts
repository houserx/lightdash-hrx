import { type AlertingAsCodeDocument } from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    assertValidAlertingAsCodeFiles,
    dumpAlertingAsCodeYaml,
    getAlertingAsCodeFilePath,
    readAlertingAsCodeFiles,
} from './alertingAsCode';

const base = path.join('/tmp', 'out');

const rule: AlertingAsCodeDocument = {
    version: 1,
    type: 'alert_rule',
    slug: 'rds-free-storage-low',
    name: 'RDS free storage low',
    description: 'Free storage below 10%',
    query: `SELECT ${Array.from({ length: 30 }, (_, i) => `c${i}`).join(', ')} FROM t`,
    condition: { operator: '<', threshold: 10 },
};

describe('getAlertingAsCodeFilePath', () => {
    it('puts each document type in its folder', () => {
        expect(getAlertingAsCodeFilePath(rule, base)).toBe(
            path.join(base, 'alert-rules', 'rds-free-storage-low.yml'),
        );
        expect(
            getAlertingAsCodeFilePath(
                {
                    version: 1,
                    type: 'contact_point',
                    slug: 'slack-infra',
                    name: 'Slack infra',
                    integrations: [],
                },
                base,
            ),
        ).toBe(path.join(base, 'contact-points', 'slack-infra.yml'));
        expect(
            getAlertingAsCodeFilePath(
                {
                    version: 1,
                    type: 'notification_routes',
                    contactPoint: 'slack-infra',
                },
                base,
            ),
        ).toBe(
            path.join(base, 'notification-routes', 'notification-routes.yml'),
        );
    });

    it('refuses a slug that is not a safe file name', () => {
        expect(() =>
            getAlertingAsCodeFilePath({ ...rule, slug: '../escape' }, base),
        ).toThrow(/invalid slug/);
    });
});

describe('dumpAlertingAsCodeYaml', () => {
    it('round-trips the document and keeps long queries on one line', () => {
        const text = dumpAlertingAsCodeYaml(rule);
        expect(yaml.load(text)).toEqual(rule);
        expect(text).toContain(`query: ${rule.query}\n`);
        expect(text.startsWith('version: 1\ntype: alert_rule\n')).toBe(true);
    });
});

describe('readAlertingAsCodeFiles', () => {
    let dir: string;
    const write = async (relative: string, content: string) => {
        const file = path.join(dir, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
    };
    const contactPoint = (slug: string): AlertingAsCodeDocument => ({
        version: 1,
        type: 'contact_point',
        slug,
        name: slug,
        integrations: [],
    });
    const routes: AlertingAsCodeDocument = {
        version: 1,
        type: 'notification_routes',
        contactPoint: 'a-slack',
    };

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerting-as-code-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns contact points, then the route tree, then rules', async () => {
        await write('alert-rules/rds-free-storage-low.yml', yaml.dump(rule));
        await write(
            'notification-routes/notification-routes.yml',
            yaml.dump(routes),
        );
        await write(
            'contact-points/b-incident.yaml',
            yaml.dump(contactPoint('b-incident')),
        );
        await write(
            'contact-points/a-slack.yml',
            yaml.dump(contactPoint('a-slack')),
        );
        await write('contact-points/README.md', 'not a document');

        const files = await readAlertingAsCodeFiles(dir);

        expect(files.map(({ document }) => document)).toEqual([
            contactPoint('a-slack'),
            contactPoint('b-incident'),
            routes,
            rule,
        ]);
        expect(files[0].filePath).toBe(
            path.join(dir, 'contact-points', 'a-slack.yml'),
        );
    });

    it('returns nothing when the folders are missing', async () => {
        await expect(readAlertingAsCodeFiles(dir)).resolves.toEqual([]);
    });

    it('names the file whose document is in the wrong folder', async () => {
        await write('alert-rules/oops.yml', yaml.dump(contactPoint('oops')));
        await expect(readAlertingAsCodeFiles(dir)).rejects.toThrow(
            /oops\.yml: files in alert-rules\/ must be alert_rule documents/,
        );
    });

    it('names the file that is not valid YAML', async () => {
        await write('contact-points/broken.yml', 'name: [unclosed');
        await expect(readAlertingAsCodeFiles(dir)).rejects.toThrow(
            /broken\.yml: invalid YAML/,
        );
    });
});

describe('assertValidAlertingAsCodeFiles', () => {
    const slack = (url: unknown) =>
        ({
            version: 1,
            type: 'contact_point',
            slug: 'slack-infra',
            name: 'Slack infra',
            integrations: [{ type: 'slack_webhook', url }],
        }) as AlertingAsCodeDocument;
    const leakyUrl = 'https://hooks.slack.com/services/T0/B0/not-a-real-secret';

    it('accepts documents whose secrets are references', () => {
        expect(() =>
            assertValidAlertingAsCodeFiles([
                {
                    filePath: 'contact-points/slack-infra.yml',
                    document: slack({ secretRef: 'slack-infra-webhook' }),
                },
            ]),
        ).not.toThrow();
    });

    it('names the file and field of an inlined secret, without its value', () => {
        let message = '';
        try {
            assertValidAlertingAsCodeFiles([
                {
                    filePath: 'contact-points/slack-infra.yml',
                    document: slack(leakyUrl),
                },
            ]);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(
            /contact-points\/slack-infra\.yml: integrations\[0\]\.url: .*secretRef/,
        );
        expect(message).not.toContain(leakyUrl);
    });

    it('lists the problems of every file', () => {
        expect(() =>
            assertValidAlertingAsCodeFiles([
                { filePath: 'contact-points/a.yml', document: slack(leakyUrl) },
                {
                    filePath: 'alert-rules/b.yml',
                    document: { ...rule, condition: undefined } as never,
                },
            ]),
        ).toThrow(/a\.yml: integrations\[0\]\.url[\s\S]*b\.yml: condition/);
    });
});
