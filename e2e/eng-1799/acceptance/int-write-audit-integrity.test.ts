/* eslint-disable */
// @ts-nocheck
// int-write-audit-integrity: a Write Mode commit from Lightdash writes one audit item and one S3
// Object Lock object in the portal's format: the fields map from the identity and the request,
// the integrityHash matches the db-query-portal's computeIntegrityHash, and the S3 body is
// JSON.stringify(item, null, 2) in the portal's key order.
import { AUDIT_INTEGRITY_KEY, buildAccount, buildFederationService, disposeAll, harness, portalIntegrityHash, PROJECT_UUID, track } from './support';

afterAll(disposeAll);

const STATEMENT = "UPDATE widgets SET name = 'widget-renamed' WHERE id = 42";
const PORTAL_KEY_ORDER = ['id', 'sql', 'mode', 'description', 'database', 'linearTicketId', 'savedScriptId', 'executedByEmail', 'executedBySub', 'status', 'rowCount', 'durationMs', 'errorMessage', 'preview', 'action', 'integrityHash', 'createdAt', 'createdAtMonth'];

describe('int-write-audit-integrity', () => {
    it('audits the commit with a portal-compatible integrity hash', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { account, userUuid, email } = await buildAccount();
        const service = await buildFederationService(engine, { platform_write: ['true'] });

        const { confirmationToken } = await service.createWriteConfirmation(account, PROJECT_UUID, STATEMENT);
        const result = await service.write(account, PROJECT_UUID, { statement: STATEMENT, mode: 'commit', confirmationToken, description: 'Rename a synthetic widget', ticket: 'OPS-77' });

        const items = engine.auditStore.items();
        expect(items).toHaveLength(1);
        const item = items[0];
        expect(item.id).toBe(result.audit_id);
        expect(item).toMatchObject({
            sql: STATEMENT,
            mode: 'write',
            description: 'Rename a synthetic widget',
            database: 'platform',
            linearTicketId: 'OPS-77',
            executedBySub: userUuid,
            executedByEmail: email,
            status: 'success',
            rowCount: 1,
            preview: false,
            action: 'query',
            errorMessage: null,
        });
        expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Number.isInteger(item.durationMs)).toBe(true);
        expect(item.integrityHash).toBe(portalIntegrityHash(item, AUDIT_INTEGRITY_KEY));

        const [object] = engine.auditStore.objects();
        expect(object.key).toBe(`executions/${item.createdAt}/${item.id}.json`);
        const ordered = Object.fromEntries(PORTAL_KEY_ORDER.filter((k) => k in item).map((k) => [k, item[k]]));
        expect(object.body).toBe(JSON.stringify(ordered, null, 2));
    });
});
