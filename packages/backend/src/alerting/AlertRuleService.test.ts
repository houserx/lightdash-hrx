import { ParameterError } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { parseAlertRuleListFilters } from './AlertRuleService';

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
