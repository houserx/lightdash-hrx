import { describe, expect, it } from 'vitest';
import { validateAlertingAsCode } from './asCode';

const rule = {
    version: 1,
    type: 'alert_rule',
    slug: 'disk-almost-full',
    name: 'Disk almost full',
    description: 'Disk usage on a database host is above 90%',
    spaceSlug: 'platform',
    labels: { team: 'infra' },
    query: 'SELECT host, value FROM disk_usage',
    condition: { operator: '>', threshold: 90 },
};

const contactPoint = {
    version: 1,
    type: 'contact_point',
    slug: 'infra-slack',
    name: 'Infra Slack',
    integrations: [
        { type: 'slack_webhook', url: { secretRef: 'infra-slack-webhook' } },
        { type: 'email', addresses: ['oncall@example.test'] },
    ],
};

const routes = {
    version: 1,
    type: 'notification_routes',
    contactPoint: 'infra-slack',
    routes: [
        {
            matchers: [{ label: 'severity', operator: '=~', value: '1|2' }],
            routes: [
                { matchers: [{ label: 'team', operator: '!=', value: 'x' }] },
            ],
        },
    ],
};

describe('validateAlertingAsCode', () => {
    it('accepts minimal documents of each type', () => {
        for (const doc of [rule, contactPoint, routes])
            expect(validateAlertingAsCode(doc)).toEqual({
                valid: true,
                errors: [],
            });
    });

    it('names missing and blank fields', () => {
        const { description: _d, ...noDescription } = rule;
        expect(validateAlertingAsCode(noDescription).errors).toEqual([
            'description: is required',
        ]);
        expect(
            validateAlertingAsCode({ ...rule, description: '  ' }).errors,
        ).toEqual(['description: must not be empty']);
    });

    it('lists the allowed values of enums and checks durations', () => {
        expect(
            validateAlertingAsCode({ ...rule, reducer: 'median' }).errors,
        ).toEqual(['reducer: must be one of last, mean, max, min, sum, count']);
        for (const interval of ['soon', '-1m', '30m1h', ''])
            expect(validateAlertingAsCode({ ...rule, interval }).valid).toBe(
                false,
            );
        for (const interval of ['0', '30s', '1h30m', '500ms'])
            expect(validateAlertingAsCode({ ...rule, interval }).valid).toBe(
                true,
            );
    });

    it('checks threshold and range conditions', () => {
        const withCondition = (condition: unknown) =>
            validateAlertingAsCode({ ...rule, condition });
        expect(withCondition({ operator: '>', threshold: 'high' }).valid).toBe(
            false,
        );
        expect(withCondition({ operator: '=>', threshold: 1 }).valid).toBe(
            false,
        );
        expect(
            withCondition({ operator: 'outside_range', min: 10, max: 20 })
                .valid,
        ).toBe(true);
        expect(
            withCondition({ operator: 'within_range', min: 20, max: 10 })
                .errors,
        ).toEqual(['condition: min must not be greater than max']);
        expect(
            withCondition({ operator: 'within_range', threshold: 1 }).valid,
        ).toBe(false);
    });

    it('rejects inline secrets naming secretRef', () => {
        const inline = (integration: unknown) =>
            validateAlertingAsCode({
                ...contactPoint,
                integrations: [integration],
            });
        const slack = inline({
            type: 'slack_webhook',
            url: 'https://hooks.slack.com/services/T0/B0/test-secret-not-real',
        });
        expect(slack.valid).toBe(false);
        expect(slack.errors).toEqual([
            'integrations[0].url: must be a secret reference { secretRef: <name> }; secrets are never written inline',
        ]);
        expect(
            inline({
                type: 'incident_io',
                url: 'https://x.test',
                token: 'test-secret-not-real',
            }).errors.join('\n'),
        ).toMatch(/integrations\[0\]\.token: .*secretRef/);
        expect(
            inline({
                type: 'webhook',
                url: 'https://x.test',
                authorization: 'Bearer test-secret-not-real',
            }).errors.join('\n'),
        ).toMatch(/integrations\[0\]\.authorization: .*secretRef/);
    });

    it('rejects unknown integrations, bad emails and empty contact points', () => {
        expect(
            validateAlertingAsCode({
                ...contactPoint,
                integrations: [{ type: 'pagerduty' }],
            }).valid,
        ).toBe(false);
        expect(
            validateAlertingAsCode({
                ...contactPoint,
                integrations: [{ type: 'email', addresses: ['not-an-email'] }],
            }).valid,
        ).toBe(false);
        expect(
            validateAlertingAsCode({ ...contactPoint, integrations: [] }).valid,
        ).toBe(false);
        expect(
            validateAlertingAsCode({
                ...contactPoint,
                integrations: [{ type: 'slack_app', channel: '#x', url: 'y' }],
            }).errors,
        ).toEqual(['integrations[0].url: is not allowed']);
    });

    it('rejects bad matchers, including invalid regexes, at any depth', () => {
        const nested = (matcher: unknown) =>
            validateAlertingAsCode({
                ...routes,
                routes: [{ routes: [{ matchers: [matcher] }] }],
            });
        expect(
            nested({ label: 'team', operator: '~', value: 'x' }).errors,
        ).toEqual([
            'routes[0].routes[0].matchers[0].operator: must be one of =, !=, =~, !~',
        ]);
        expect(
            nested({ label: 'team', operator: '=~', value: '(' }).errors,
        ).toEqual([
            'routes[0].routes[0].matchers[0]: Invalid regex "(" for label "team"',
        ]);
        expect(
            validateAlertingAsCode({ ...routes, matchers: [] }).errors,
        ).toEqual(['matchers: is not allowed']);
    });

    it('rejects non-documents and unknown types', () => {
        expect(validateAlertingAsCode(null).errors).toEqual([
            'document: must be an object',
        ]);
        expect(validateAlertingAsCode({ version: 1, type: 'chart' })).toEqual({
            valid: false,
            errors: [
                'type: must be one of alert_rule, contact_point, notification_routes',
            ],
        });
        expect(validateAlertingAsCode({ ...rule, version: 2 }).errors).toEqual([
            'version: must be 1',
        ]);
    });
});
