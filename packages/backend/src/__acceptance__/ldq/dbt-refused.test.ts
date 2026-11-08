// ldq-federation-dbt-refused: dbt with a federation-flavour connection fails with a clear error
// where the dbt target is built (CONTRACTS §4.1). Plain Postgres still builds a target.
import { toDbtTarget } from '../../dbt/targets';

const base = {
    type: 'postgres',
    host: '127.0.0.1',
    port: 5433,
    user: 'lightdash-operations',
    password: 'test-password-not-real',
    dbname: 'operations',
    schema: 'public',
};

describe('toDbtTarget', () => {
    it('refuses the Federation Engine with a clear message', () => {
        expect(() =>
            toDbtTarget(
                {
                    ...base,
                    flavor: 'federation',
                    identitySigningSecret: 'test-secret-not-real',
                } as never,
                { explicitCredentials: false },
            ),
        ).toThrow('dbt is not supported for the Federation Engine');
        expect(() =>
            toDbtTarget(
                { ...base, flavor: 'federation' } as never,
                { explicitCredentials: true },
            ),
        ).toThrow('dbt is not supported for the Federation Engine');
    });

    it('still builds a Postgres target for plain Postgres', () => {
        const result = toDbtTarget({ ...base, flavor: 'postgres' } as never, {
            explicitCredentials: false,
        });
        expect(JSON.stringify(result)).toContain('postgres');
    });
});
