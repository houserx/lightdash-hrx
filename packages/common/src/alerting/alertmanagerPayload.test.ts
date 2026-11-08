import { describe, expect, it } from 'vitest';
import {
    ALERTMANAGER_ZERO_TIME,
    buildAlertmanagerWebhookPayload,
    type AlertmanagerPayloadAlertInput,
} from './alertmanagerPayload';

const firing: AlertmanagerPayloadAlertInput = {
    status: 'firing',
    labels: { alertname: 'Disk almost full', instance: 'db-1', team: 'infra' },
    annotations: { summary: 'Disk almost full', runbook: 'r1' },
    startsAt: '2026-11-08T09:00:00.000Z',
    endsAt: '2026-11-08T09:30:00.000Z',
    fingerprint: 'aaaaaaaaaaaaaaaa',
    generatorURL: 'https://lightdash.example.test/r/1',
};

const resolved: AlertmanagerPayloadAlertInput = {
    status: 'resolved',
    labels: { alertname: 'Disk almost full', instance: 'db-2', team: 'infra' },
    annotations: { summary: 'Disk almost full' },
    startsAt: '2026-11-08T08:00:00.000Z',
    endsAt: '2026-11-08T09:05:00.000Z',
    fingerprint: 'bbbbbbbbbbbbbbbb',
};

const build = (alerts: AlertmanagerPayloadAlertInput[], maxAlerts?: number) =>
    buildAlertmanagerWebhookPayload({
        receiver: 'incident-io',
        groupKey: 'root:{}',
        groupLabels: { alertname: 'Disk almost full', empty: '' },
        externalURL: 'https://lightdash.example.test',
        alerts,
        maxAlerts,
    });

describe('buildAlertmanagerWebhookPayload', () => {
    it('builds the v4 envelope with shared labels and annotations', () => {
        const payload = build([firing, resolved]);
        expect(payload).toEqual({
            version: '4',
            groupKey: 'root:{}',
            truncatedAlerts: 0,
            status: 'firing',
            receiver: 'incident-io',
            groupLabels: { alertname: 'Disk almost full' },
            commonLabels: { alertname: 'Disk almost full', team: 'infra' },
            commonAnnotations: { summary: 'Disk almost full' },
            externalURL: 'https://lightdash.example.test',
            alerts: [
                {
                    status: 'firing',
                    labels: firing.labels,
                    annotations: firing.annotations,
                    startsAt: firing.startsAt,
                    endsAt: ALERTMANAGER_ZERO_TIME,
                    generatorURL: 'https://lightdash.example.test/r/1',
                    fingerprint: 'aaaaaaaaaaaaaaaa',
                },
                {
                    status: 'resolved',
                    labels: resolved.labels,
                    annotations: resolved.annotations,
                    startsAt: resolved.startsAt,
                    endsAt: '2026-11-08T09:05:00.000Z',
                    generatorURL: '',
                    fingerprint: 'bbbbbbbbbbbbbbbb',
                },
            ],
        });
    });

    it('is resolved only when every alert is resolved', () => {
        expect(build([resolved]).status).toBe('resolved');
        expect(build([]).status).toBe('resolved');
        expect(build([]).commonLabels).toEqual({});
    });

    it('drops null and empty labels and defaults a missing endsAt', () => {
        const alert = build([
            {
                ...resolved,
                labels: { a: '1', b: null, c: '' },
                endsAt: null,
            },
        ]).alerts[0];
        expect(alert.labels).toEqual({ a: '1' });
        expect(alert.endsAt).toBe(ALERTMANAGER_ZERO_TIME);
    });

    it('truncates to maxAlerts and counts the rest', () => {
        const payload = build([firing, resolved, firing], 2);
        expect(payload.alerts).toHaveLength(2);
        expect(payload.truncatedAlerts).toBe(1);
        expect(build([firing, resolved], 0).truncatedAlerts).toBe(0);
    });
});
