// ldq-federation-credential-fields: the Federation Engine is a flavour of the Postgres
// warehouse type (CONTRACTS §4.1), never a new WarehouseTypes member.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

const federation = {
    type: 'postgres',
    flavor: 'federation',
    host: 'engine.internal.test',
    user: 'lightdash-operations',
    password: 'test-password-not-real',
    identitySigningSecret: 'test-secret-not-real',
    httpBaseUrl: 'http://engine.internal.test:8088',
    port: 5433,
    dbname: 'operations',
    schema: 'public',
};

describe('Federation Engine credentials', () => {
    it('does not add a WarehouseTypes member', () => {
        expect(Object.values(common.WarehouseTypes)).not.toContain(
            'federation',
        );
    });

    it('exposes the engine defaults: port 5433 and dbname operations', () => {
        expect(common.FEDERATION_DEFAULT_PORT).toBe(5433);
        expect(common.FEDERATION_DEFAULT_DBNAME).toBe('operations');
    });

    it('treats identitySigningSecret as a sensitive credential field', () => {
        expect(common.sensitiveCredentialsFieldNames).toContain(
            'identitySigningSecret',
        );
        expect(common.sensitiveCredentialsFieldNames).not.toContain(
            'httpBaseUrl',
        );
        expect(common.sensitiveCredentialsFieldNames).not.toContain('flavor');
    });

    it('recognises federation-flavour credentials only', () => {
        expect(common.isFederationCredentials(federation)).toBe(true);
        expect(
            common.isFederationCredentials({ ...federation, flavor: 'postgres' }),
        ).toBe(false);
        const { flavor, ...plainPostgres } = federation;
        expect(flavor).toBe('federation');
        expect(common.isFederationCredentials(plainPostgres)).toBe(false);
        expect(
            common.isFederationCredentials({
                ...federation,
                type: 'redshift',
            }),
        ).toBe(false);
        expect(common.isFederationCredentials(undefined)).toBe(false);
    });

    it('recognises a federation project from its warehouse connection', () => {
        const { identitySigningSecret, password, user, ...safe } = federation;
        expect([identitySigningSecret, password, user]).toHaveLength(3);
        expect(
            common.isFederationProject({ warehouseConnection: safe }),
        ).toBe(true);
        expect(
            common.isFederationProject({
                warehouseConnection: { ...safe, flavor: 'postgres' },
            }),
        ).toBe(false);
        expect(common.isFederationProject({})).toBe(false);
        expect(common.isFederationProject(undefined)).toBe(false);
    });
});
