import { ParameterError } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import {
    parseAlertHistoryQuery,
    parseAlertRuleListFilters,
    parseAlertStateQuery,
} from './AlertRuleService';

const SPACE_UUID = '2c89ca3e-58d7-420c-b73a-b64da9adcc15';

describe('parseAlertRuleListFilters', () => {
    it('returns no filters for an empty query and ignores other parameters', () => {
        expect(parseAlertRuleListFilters({})).toEqual({});
        expect(parseAlertRuleListFilters({ page: '2' })).toEqual({});
    });

    it('reads state, spaceUuid and repeated labels', () => {
        expect(
            parseAlertRuleListFilters({
                state: 'firing',
                spaceUuid: SPACE_UUID,
                label: ['team=infra', 'query=a=b'],
            }),
        ).toEqual({
            state: 'firing',
            spaceUuid: SPACE_UUID,
            labels: { team: 'infra', query: 'a=b' },
        });
        expect(parseAlertRuleListFilters({ label: 'team=' })).toEqual({
            labels: { team: '' },
        });
    });

    it.each([
        [{ state: 'resolved' }, /state must be one of/],
        [{ state: ['firing', 'normal'] }, /state must be given at most once/],
        [{ spaceUuid: 'nope' }, /spaceUuid must be a uuid/],
        [{ label: 'team' }, /label must be key=value/],
        [{ label: '=infra' }, /label must be key=value/],
        [
            { label: ['team=a', 'team=b'] },
            /label team must be given at most once/,
        ],
        [{ label: { team: 'infra' } }, /label must be a string/],
    ])('refuses %j', (query, message) => {
        expect(() => parseAlertRuleListFilters(query)).toThrow(ParameterError);
        expect(() => parseAlertRuleListFilters(query)).toThrow(message);
    });
});

const RULE_UUID = '7d3c1f0e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

describe('parseAlertStateQuery', () => {
    it('reads rule and ignores other parameters', () => {
        expect(parseAlertStateQuery({})).toEqual({});
        expect(parseAlertStateQuery({ ruleUuid: RULE_UUID })).toEqual({});
        expect(parseAlertStateQuery({ rule: RULE_UUID })).toEqual({
            ruleUuid: RULE_UUID,
        });
    });

    it.each([
        [{ rule: 'nope' }, /rule must be a uuid/],
        [{ rule: [RULE_UUID, RULE_UUID] }, /rule must be given at most once/],
    ])('refuses %j', (query, message) => {
        expect(() => parseAlertStateQuery(query)).toThrow(ParameterError);
        expect(() => parseAlertStateQuery(query)).toThrow(message);
    });
});

describe('parseAlertHistoryQuery', () => {
    it('reads rule, since, until and limit, with limit 100 by default', () => {
        expect(parseAlertHistoryQuery({})).toEqual({ limit: 100 });
        expect(
            parseAlertHistoryQuery({
                rule: RULE_UUID,
                since: '2026-11-08T00:00:00Z',
                until: '2026-11-08T12:00:00.000Z',
                limit: '25',
            }),
        ).toEqual({
            ruleUuid: RULE_UUID,
            since: new Date('2026-11-08T00:00:00Z'),
            until: new Date('2026-11-08T12:00:00Z'),
            limit: 25,
        });
    });

    it.each([
        [{ until: '2026-11-08' }, /until must be an ISO 8601 time/],
        [{ since: 'yesterday' }, /since must be an ISO 8601 time/],
        [
            { since: '2026-11-08T12:00:00Z', until: '2026-11-08T00:00:00Z' },
            /until must not be before since/,
        ],
        [{ limit: '0' }, /limit must be a whole number/],
    ])('refuses %j', (query, message) => {
        expect(() => parseAlertHistoryQuery(query)).toThrow(ParameterError);
        expect(() => parseAlertHistoryQuery(query)).toThrow(message);
    });
});
