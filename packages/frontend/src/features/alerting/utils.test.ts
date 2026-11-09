import { describe, expect, it } from 'vitest';
import {
    describeContactPointTestFailure,
    describeHistoryEntry,
    formatAlertCondition,
    formatAlertLabelMatcher,
    formatLabels,
    isSecretRefName,
    labelsToText,
    matchesLabelFilter,
    parseLabelsText,
} from './utils';

describe('matchesLabelFilter', () => {
    const labels = { team: 'infra', severity: 'critical' };

    it('matches everything when the filter is empty', () => {
        expect(matchesLabelFilter(labels, '')).toBe(true);
        expect(matchesLabelFilter({}, '  ')).toBe(true);
    });

    it('matches key=value exactly', () => {
        expect(matchesLabelFilter(labels, 'team=infra')).toBe(true);
        expect(matchesLabelFilter(labels, 'team=inf')).toBe(false);
        expect(matchesLabelFilter(labels, 'team=db')).toBe(false);
    });

    it('matches key= on the key alone', () => {
        expect(matchesLabelFilter(labels, 'team=')).toBe(true);
        expect(matchesLabelFilter(labels, 'owner=')).toBe(false);
    });

    it('matches a bare word against keys and values', () => {
        expect(matchesLabelFilter(labels, 'crit')).toBe(true);
        expect(matchesLabelFilter(labels, 'TEAM')).toBe(true);
        expect(matchesLabelFilter(labels, 'payments')).toBe(false);
    });

    it('requires every term', () => {
        expect(
            matchesLabelFilter(labels, 'team=infra, severity=critical'),
        ).toBe(true);
        expect(matchesLabelFilter(labels, 'team=infra severity=low')).toBe(
            false,
        );
    });
});

describe('formatAlertCondition', () => {
    it('formats threshold and range conditions', () => {
        expect(
            formatAlertCondition('last', 'value', {
                operator: '>',
                threshold: 90,
            }),
        ).toBe('last(value) > 90');
        expect(
            formatAlertCondition('mean', 'lag', {
                operator: 'outside_range',
                min: 1,
                max: 5,
            }),
        ).toBe('mean(lag) outside (1, 5)');
    });
});

describe('formatLabels', () => {
    it('lists key=value pairs', () => {
        expect(formatLabels({ team: 'infra', sev: '1' })).toEqual([
            'team=infra',
            'sev=1',
        ]);
        expect(formatLabels({})).toEqual([]);
    });
});

describe('describeHistoryEntry', () => {
    it('describes transitions and skipped evaluations', () => {
        expect(
            describeHistoryEntry({
                type: 'transition',
                uuid: 'h1',
                ruleUuid: 'r1',
                fingerprint: 'f',
                labels: {},
                previousState: 'normal',
                state: 'firing',
                value: 95,
                at: '2026-11-08T09:00:00Z',
            }),
        ).toBe('Normal → Firing');
        expect(
            describeHistoryEntry({
                type: 'evaluation_skipped',
                uuid: 'h2',
                ruleUuid: 'r1',
                reason: 'overrun',
                at: '2026-11-08T09:01:00Z',
            }),
        ).toBe('Skipped evaluation (overrun)');
    });
});

describe('labelsToText / parseLabelsText', () => {
    it('round-trips a label set through key=value lines', () => {
        const labels = { team: 'infra', severity: 'critical' };
        expect(labelsToText(labels)).toBe('team=infra\nseverity=critical');
        expect(parseLabelsText(labelsToText(labels))).toEqual({ labels });
    });
    it('trims, skips blank lines and keeps = in values', () => {
        expect(parseLabelsText(' team = infra \n\n url=a=b\n')).toEqual({
            labels: { team: 'infra', url: 'a=b' },
        });
        expect(parseLabelsText('')).toEqual({ labels: {} });
    });
    it('rejects a line without a key', () => {
        expect(parseLabelsText('team=infra\nbroken').error).toBe(
            'Expected key=value, got "broken"',
        );
        expect(parseLabelsText('=x').error).toMatch(/Expected key=value/);
    });
});

describe('isSecretRefName', () => {
    it('accepts secret names', () => {
        expect(isSecretRefName('slack-infra-alerts-webhook')).toBe(true);
        expect(isSecretRefName('incident_io.token2')).toBe(true);
    });

    it('rejects inline secrets and blanks', () => {
        expect(isSecretRefName('https://hooks.slack.com/services/T/B/x')).toBe(
            false,
        );
        expect(isSecretRefName('Bearer abc')).toBe(false);
        expect(isSecretRefName('-leading-dash')).toBe(false);
        expect(isSecretRefName('')).toBe(false);
    });
});

describe('describeContactPointTestFailure', () => {
    it('is null when every integration succeeded', () => {
        expect(
            describeContactPointTestFailure({
                ok: true,
                results: [{ type: 'slack_webhook', ok: true }],
            }),
        ).toBeNull();
    });

    it('names each failed integration and its error', () => {
        expect(
            describeContactPointTestFailure({
                ok: false,
                results: [
                    { type: 'email', ok: true },
                    { type: 'slack_webhook', ok: false, error: 'HTTP 500' },
                    { type: 'incident_io', ok: false },
                ],
            }),
        ).toBe('Slack webhook: HTTP 500; incident.io: failed');
    });
});

describe('formatAlertLabelMatcher', () => {
    it('shows label, operator and value', () => {
        expect(
            formatAlertLabelMatcher({
                label: 'team',
                operator: '=',
                value: 'infra',
            }),
        ).toBe('team = infra');
        expect(
            formatAlertLabelMatcher({
                label: 'severity',
                operator: '=~',
                value: 'critical|page',
            }),
        ).toBe('severity =~ critical|page');
    });
});
