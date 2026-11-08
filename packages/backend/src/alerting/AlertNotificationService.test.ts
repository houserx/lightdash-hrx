import { ParameterError } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { parseAlertNotificationListQuery } from './AlertNotificationService';

const RULE = '6f1c1c4e-2b7a-4f7e-9d43-3d7d4a0f9a11';
const CONTACT_POINT = '0b8e5d0a-58a1-4a8e-8d3e-5f2b1f7c2c22';

describe('parseAlertNotificationListQuery', () => {
    it('defaults to 100 entries and no filters', () => {
        expect(parseAlertNotificationListQuery({})).toEqual({ limit: 100 });
    });

    it('reads rule, contactPoint and limit', () => {
        expect(
            parseAlertNotificationListQuery({
                rule: RULE,
                contactPoint: CONTACT_POINT,
                limit: '25',
                other: 'ignored',
            }),
        ).toEqual({
            ruleUuid: RULE,
            contactPointUuid: CONTACT_POINT,
            limit: 25,
        });
    });

    it.each([
        [{ rule: 'not-a-uuid' }],
        [{ contactPoint: '42' }],
        [{ rule: [RULE, RULE] }],
        [{ limit: '0' }],
        [{ limit: '1001' }],
        [{ limit: '2.5' }],
        [{ limit: 'ten' }],
    ])('rejects %j', (query) => {
        expect(() => parseAlertNotificationListQuery(query)).toThrow(
            ParameterError,
        );
    });
});
