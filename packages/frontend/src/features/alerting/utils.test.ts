import { describe, expect, it } from 'vitest';
import { matchesLabelFilter } from './utils';

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
