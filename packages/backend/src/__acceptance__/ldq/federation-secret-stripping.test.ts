// ldq-federation-secret-stripping: identitySigningSecret is stripped like password wherever
// credentials are returned, and survives an update that leaves it blank.
import { sensitiveCredentialsFieldNames } from '@lightdash/common';
import { ProjectModel } from '../../models/ProjectModel/ProjectModel';

const saved = {
    type: 'postgres',
    flavor: 'federation',
    host: 'engine.internal.test',
    port: 5433,
    user: 'lightdash-operations',
    password: 'test-password-not-real',
    dbname: 'operations',
    schema: 'public',
    identitySigningSecret: 'test-secret-not-real',
    httpBaseUrl: 'http://engine.internal.test:8088',
};

describe('identitySigningSecret handling', () => {
    it('is in the list of fields stripped from API responses', () => {
        expect(sensitiveCredentialsFieldNames).toContain(
            'identitySigningSecret' as never,
        );
        const stripped = Object.fromEntries(
            Object.entries(saved).filter(
                ([key]) =>
                    !(sensitiveCredentialsFieldNames as readonly string[]).includes(
                        key,
                    ),
            ),
        );
        expect(stripped).not.toHaveProperty('identitySigningSecret');
        expect(stripped).toHaveProperty('httpBaseUrl', saved.httpBaseUrl);
        expect(stripped).toHaveProperty('flavor', 'federation');
    });

    it('keeps the saved secret when an update leaves it blank', () => {
        const merged = ProjectModel.mergeMissingWarehouseSecrets(
            { ...saved, identitySigningSecret: '', password: '' } as never,
            saved as never,
        ) as unknown as typeof saved;
        expect(merged.identitySigningSecret).toBe('test-secret-not-real');
        expect(merged.password).toBe('test-password-not-real');
    });

    it('replaces the secret when an update provides a new one', () => {
        const merged = ProjectModel.mergeMissingWarehouseSecrets(
            {
                ...saved,
                identitySigningSecret: 'rotated-test-secret-not-real',
            } as never,
            saved as never,
        ) as unknown as typeof saved;
        expect(merged.identitySigningSecret).toBe(
            'rotated-test-secret-not-real',
        );
    });
});
