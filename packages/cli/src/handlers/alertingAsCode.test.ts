import { type AlertingAsCodeDocument } from '@lightdash/common';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    dumpAlertingAsCodeYaml,
    getAlertingAsCodeFilePath,
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
