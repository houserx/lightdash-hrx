import { describe, expect, it } from 'vitest';
import { resolveAttrs } from './userMapping.js';

const NONE = { telemetry_restricted: false, platform_read: false, platform_write: false, platform_explain: false };

const read = (attribute: Record<string, unknown>, groups: string[] = []) =>
    resolveAttrs([{ name: 'platform_read', ...attribute }], 'u1', new Set(groups)).platform_read;

describe('resolveAttrs (Lightdash user attributes -> §3 attrs)', () => {
    it('reads the canonical values arrays as well as the deprecated single fields', () => {
        expect(read({ users: [{ userUuid: 'u1', values: ['true'], value: 'true' }] })).toBe(true);
        expect(read({ groups: [{ groupUuid: 'g1', values: ['true'] }] }, ['g1'])).toBe(true);
        expect(read({ attributeDefaults: ['true'], attributeDefault: 'true' })).toBe(true);
        expect(read({ attributeDefault: ['true'] })).toBe(true);
        // `values` wins over the deprecated `value`, as in Lightdash
        expect(read({ users: [{ userUuid: 'u1', values: ['false'], value: 'true' }] })).toBe(false);
    });

    it('uses defaults only when neither the user nor any of their groups has a value', () => {
        expect(read({ attributeDefaults: ['true'] })).toBe(true);
        expect(read({ groups: [{ groupUuid: 'g1', values: ['false'] }], attributeDefaults: ['true'] }, ['g1'])).toBe(
            false,
        );
        expect(read({ users: [{ userUuid: 'u1', values: [] }], attributeDefaults: ['true'] })).toBe(true);
        // a group the user is not in does not count
        expect(read({ groups: [{ groupUuid: 'g2', values: ['false'] }], attributeDefaults: ['true'] }, ['g1'])).toBe(
            true,
        );
    });

    it('is true when any resolved value is exactly "true", like Lightdash', () => {
        for (const v of ['TRUE', 'True', ' true', 'yes', '1', '']) {
            expect(read({ users: [{ userUuid: 'u1', value: v }] }), v).toBe(false);
        }
        // the same "true" from the user and two groups
        expect(
            read(
                {
                    users: [{ userUuid: 'u1', value: 'true' }],
                    groups: [
                        { groupUuid: 'g1', value: 'true' },
                        { groupUuid: 'g2', values: ['true'] },
                    ],
                },
                ['g1', 'g2'],
            ),
        ).toBe(true);
        // a mixed set is true as soon as one value is "true" (identityAttrsFromUserAttributes' reading)
        const mixed = {
            users: [{ userUuid: 'u1', value: 'false' }],
            groups: [{ groupUuid: 'g1', value: 'true' }],
        };
        expect(read(mixed, ['g1'])).toBe(true);
        expect(read({ users: [{ userUuid: 'u1', values: ['true', 'false'] }] })).toBe(true);
        expect(read({ attributeDefaults: ['true', 'x'] })).toBe(true);
        expect(read({ users: [{ userUuid: 'u1', values: ['false', 'TRUE', 'yes'] }] })).toBe(false);
    });

    it('ignores other users, unknown attributes and malformed entries', () => {
        expect(read({ users: [{ userUuid: 'u2', value: 'true' }] })).toBe(false);
        expect(read({ users: [{ userUuid: 'u1', values: [1, null], value: 7 }], attributeDefault: true })).toBe(false);
        expect(resolveAttrs([{ name: 'platform_admin', attributeDefaults: ['true'] }], 'u1', new Set())).toEqual(NONE);
        expect(resolveAttrs([], 'u1', new Set())).toEqual(NONE);
    });
});
