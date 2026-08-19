import { resolveRoleScopes } from './resolveRoleScopes';

describe('resolveRoleScopes', () => {
    describe('given the effective role_uuid has a scoped_roles row', () => {
        it('then returns the DB-backed scopes, regardless of whether it is a custom or well-known-system uuid', () => {
            expect(
                resolveRoleScopes({
                    effectiveRoleUuid: 'some-uuid',
                    hasCustomRoleUuid: true,
                    systemRoleScopes: ['view:Dashboard'],
                    customRoleScopes: { 'some-uuid': ['manage:Space'] },
                }),
            ).toEqual(['manage:Space']);

            expect(
                resolveRoleScopes({
                    effectiveRoleUuid: 'well-known-uuid',
                    hasCustomRoleUuid: false,
                    systemRoleScopes: ['view:Dashboard'],
                    customRoleScopes: { 'well-known-uuid': ['manage:Space'] },
                }),
            ).toEqual(['manage:Space']);
        });
    });

    describe('given the effective role_uuid has no scoped_roles row', () => {
        describe('when it is a genuine custom role_uuid (dangling reference)', () => {
            it('then fails closed, returning undefined', () => {
                expect(
                    resolveRoleScopes({
                        effectiveRoleUuid: 'dangling-uuid',
                        hasCustomRoleUuid: true,
                        systemRoleScopes: ['view:Dashboard'],
                        customRoleScopes: {},
                    }),
                ).toBeUndefined();

                expect(
                    resolveRoleScopes({
                        effectiveRoleUuid: 'dangling-uuid',
                        hasCustomRoleUuid: true,
                        systemRoleScopes: ['view:Dashboard'],
                        customRoleScopes: undefined,
                    }),
                ).toBeUndefined();
            });
        });

        describe('when it is a well-known system role_uuid (transitional gap)', () => {
            it('then falls back to the literal system-role scope list', () => {
                expect(
                    resolveRoleScopes({
                        effectiveRoleUuid: 'well-known-uuid',
                        hasCustomRoleUuid: false,
                        systemRoleScopes: ['view:Dashboard'],
                        customRoleScopes: {},
                    }),
                ).toEqual(['view:Dashboard']);

                expect(
                    resolveRoleScopes({
                        effectiveRoleUuid: 'well-known-uuid',
                        hasCustomRoleUuid: false,
                        systemRoleScopes: ['view:Dashboard'],
                        customRoleScopes: undefined,
                    }),
                ).toEqual(['view:Dashboard']);
            });
        });
    });
});
