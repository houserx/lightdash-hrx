import { type AlertTemplateAlert } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { buildEmailMessage } from './emailMessage';

const alert = (
    status: 'firing' | 'resolved',
    instance: string,
    annotations: Record<string, string> = {
        summary: 'Disk almost full',
        description: 'A database disk is above 90%',
    },
): AlertTemplateAlert => ({
    Status: status,
    Labels: { alertname: 'Disk almost full', instance },
    Annotations: annotations,
    StartsAt: '2026-01-01T00:00:00.000Z',
    EndsAt: '0001-01-01T00:00:00Z',
    Fingerprint: instance,
    GeneratorURL: `https://lightdash.test/rules/${instance}`,
    SilenceURL: '',
    DashboardURL: '',
    ValueString: '',
});

describe('buildEmailMessage', () => {
    it('puts the status, count and rule name in the subject', () => {
        const message = buildEmailMessage({
            alerts: [alert('firing', 'db-1'), alert('firing', 'db-2')],
            groupLabels: { alertname: 'Disk almost full' },
        });
        expect(message.subject).toBe('[FIRING:2] Disk almost full');
    });

    it('counts resolved alerts and adds the other group label values', () => {
        expect(
            buildEmailMessage({
                alerts: [alert('firing', 'db-1'), alert('resolved', 'db-2')],
                groupLabels: { alertname: 'Disk almost full', team: 'infra' },
            }).subject,
        ).toBe('[FIRING:1, RESOLVED:1] Disk almost full (infra)');
        expect(
            buildEmailMessage({
                alerts: [alert('resolved', 'db-1')],
                groupLabels: {},
            }).subject,
        ).toBe('[RESOLVED] Disk almost full');
    });

    it('keeps line breaks out of the subject', () => {
        expect(
            buildEmailMessage({
                alerts: [alert('firing', 'db-1')],
                groupLabels: { alertname: 'x', team: 'a\r\nBcc: b' },
            }).subject,
        ).toBe('[FIRING:1] Disk almost full (a Bcc: b)');
    });

    it('lists each alert with its description, labels and link', () => {
        const message = buildEmailMessage({
            alerts: [
                alert('firing', 'db-1', {
                    description: 'A database disk is above 90%',
                    runbook_url: 'https://runbooks.test/disk',
                }),
                alert('resolved', 'db-2'),
            ],
            groupLabels: { alertname: 'Disk almost full' },
        });
        expect(message.text).toBe(
            [
                'Firing (1)',
                '',
                'Description: A database disk is above 90%',
                'Labels: alertname=Disk almost full, instance=db-1',
                'Runbook: https://runbooks.test/disk',
                'Rule: https://lightdash.test/rules/db-1',
                '',
                'Resolved (1)',
                '',
                'Summary: Disk almost full',
                'Description: A database disk is above 90%',
                'Labels: alertname=Disk almost full, instance=db-2',
                'Rule: https://lightdash.test/rules/db-2',
            ].join('\n'),
        );
    });

    it('escapes HTML in the html body', () => {
        const message = buildEmailMessage({
            alerts: [
                alert('firing', 'db-1', { description: '<b>"disk" & co</b>' }),
            ],
            groupLabels: {},
        });
        expect(message.html).toContain(
            'Description: &lt;b&gt;&quot;disk&quot; &amp; co&lt;/b&gt;',
        );
        expect(message.html).not.toContain('<b>');
    });
});
