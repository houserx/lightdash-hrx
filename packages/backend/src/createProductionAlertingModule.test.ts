import {
    MissingConfigError,
    SlackInstallationNotFoundError,
} from '@lightdash/common';
import { describe, expect, it, vi } from 'vitest';
import { NotificationSendError } from './alerting/AlertNotifier';
import {
    ALERTING_JOB_MAX_ATTEMPTS,
    createAlertEmailClient,
    createAlertSlackApp,
    createEnvAlertingSecrets,
    createGraphileAlertJobQueue,
    getAlertEvaluatorAttrs,
    getAlertingHeartbeatConfig,
    getAlertingSecretEnvName,
} from './createProductionAlertingModule';

describe('getAlertingHeartbeatConfig', () => {
    it('is null without a URL', () => {
        expect(getAlertingHeartbeatConfig({})).toBeNull();
        expect(
            getAlertingHeartbeatConfig({ ALERTING_HEARTBEAT_URL: ' ' }),
        ).toBeNull();
    });

    it('defaults to POST and accepts GET in any case', () => {
        expect(
            getAlertingHeartbeatConfig({
                ALERTING_HEARTBEAT_URL: 'https://beat.example.test/x',
            }),
        ).toEqual({ url: 'https://beat.example.test/x', method: 'POST' });
        expect(
            getAlertingHeartbeatConfig({
                ALERTING_HEARTBEAT_URL: 'https://beat.example.test/x',
                ALERTING_HEARTBEAT_METHOD: 'get',
            }),
        ).toEqual({ url: 'https://beat.example.test/x', method: 'GET' });
    });

    it('rejects a bad URL or method', () => {
        expect(() =>
            getAlertingHeartbeatConfig({ ALERTING_HEARTBEAT_URL: 'nope' }),
        ).toThrow('ALERTING_HEARTBEAT_URL');
        expect(() =>
            getAlertingHeartbeatConfig({
                ALERTING_HEARTBEAT_URL: 'https://beat.example.test/x',
                ALERTING_HEARTBEAT_METHOD: 'PUT',
            }),
        ).toThrow('ALERTING_HEARTBEAT_METHOD');
    });
});

describe('getAlertEvaluatorAttrs', () => {
    const none = {
        telemetry_restricted: false,
        platform_read: false,
        platform_write: false,
        platform_explain: false,
    };

    it('holds no attrs when unset or empty', () => {
        expect(getAlertEvaluatorAttrs({})).toEqual(none);
        expect(
            getAlertEvaluatorAttrs({ ALERTING_EVALUATOR_ATTRS: ' ' }),
        ).toEqual(none);
    });

    it('holds the comma-separated claims listed', () => {
        expect(
            getAlertEvaluatorAttrs({
                ALERTING_EVALUATOR_ATTRS:
                    ' telemetry_restricted, platform_read ',
            }),
        ).toEqual({
            ...none,
            telemetry_restricted: true,
            platform_read: true,
        });
    });

    it('rejects an unknown claim name', () => {
        expect(() =>
            getAlertEvaluatorAttrs({ ALERTING_EVALUATOR_ATTRS: 'telemetry' }),
        ).toThrow(/unknown claim names: telemetry/);
    });
});

describe('env secrets', () => {
    it('maps secret names to upper-snake env vars', async () => {
        expect(getAlertingSecretEnvName('incident-io-grafana')).toBe(
            'ALERTING_SECRET_INCIDENT_IO_GRAFANA',
        );
        const secrets = createEnvAlertingSecrets({
            ALERTING_SECRET_SLACK_INFRA: 'test-value',
        });
        expect(await secrets.resolve('slack.infra')).toBe('test-value');
        expect(await secrets.resolve('missing')).toBeUndefined();
    });
});

describe('createGraphileAlertJobQueue', () => {
    it('adds keyed jobs with a bounded number of attempts', async () => {
        const addJob = vi.fn(async () => ({}));
        const queue = createGraphileAlertJobQueue({
            graphileUtils: Promise.resolve({ addJob }) as never,
        });
        const runAt = new Date('2026-11-08T09:00:15.000Z');
        await queue.addJob(
            'alertingTick',
            {},
            { jobKey: 'alerting-tick', runAt },
        );
        await queue.addJob(
            'alertRuleEvaluate',
            { ruleUuid: 'r' },
            { jobKey: 'k' },
        );
        expect(addJob).toHaveBeenNthCalledWith(
            1,
            'alertingTick',
            {},
            {
                jobKey: 'alerting-tick',
                runAt,
                maxAttempts: ALERTING_JOB_MAX_ATTEMPTS,
            },
        );
        expect(addJob).toHaveBeenNthCalledWith(
            2,
            'alertRuleEvaluate',
            { ruleUuid: 'r' },
            { jobKey: 'k', maxAttempts: ALERTING_JOB_MAX_ATTEMPTS },
        );
    });
});

describe('client adapters', () => {
    const message = { to: ['a@example.test'], subject: 's', text: 't' };

    it('fails email sends without SMTP, without retrying', async () => {
        const sendPrerenderedEmail = vi.fn(async () => {});
        const email = createAlertEmailClient({
            canSendEmail: () => false,
            sendPrerenderedEmail,
        });
        const error = await email.sendEmail(message).catch((e) => e);
        expect(error).toBeInstanceOf(NotificationSendError);
        expect(error.retryable).toBe(false);
        expect(sendPrerenderedEmail).not.toHaveBeenCalled();
    });

    it('sends email through the client when SMTP is set up', async () => {
        const sendPrerenderedEmail = vi.fn(async () => {});
        const email = createAlertEmailClient({
            canSendEmail: () => true,
            sendPrerenderedEmail,
        });
        await email.sendEmail(message);
        expect(sendPrerenderedEmail).toHaveBeenCalledWith(message);
    });

    it.each([
        new SlackInstallationNotFoundError(),
        new MissingConfigError('Slack is not configured'),
    ])('reports a missing Slack app as not installed', async (thrown) => {
        const slack = createAlertSlackApp({
            postMessage: vi.fn(async () => {
                throw thrown;
            }),
        });
        const error = await slack
            .postMessage({ organizationUuid: 'o', channel: '#c', text: 't' })
            .catch((e) => e);
        expect(error).toBeInstanceOf(NotificationSendError);
        expect(error.message).toMatch(/not installed/);
        expect(error.retryable).toBe(false);
    });

    it('passes other Slack errors through for retry', async () => {
        const slack = createAlertSlackApp({
            postMessage: vi.fn(async () => {
                throw new Error('rate limited');
            }),
        });
        await expect(
            slack.postMessage({
                organizationUuid: 'o',
                channel: '#c',
                text: 't',
            }),
        ).rejects.toThrow('rate limited');
    });
});
