import { describe, expect, it } from 'vitest';
import {
    describeHistoryEntry,
    formatAlertCondition,
    formatLabels,
    matchesLabelFilter,
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
