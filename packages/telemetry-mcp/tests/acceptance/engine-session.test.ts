import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ANALYST,
    IDENTITY_SECRET,
    identityOf,
    ORG_UUID,
    PROJECT_UUID,
    startHarness,
    type Harness,
} from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const catalogQueries = () => h.engine.dataQueries().filter((q) => /information_schema\.tables/i.test(q.sql));

describe('engine client: one pg-wire connection per call, identity first', () => {
    it('logs in with the configured engine credentials and database', async () => {
        const r = await h.call('list_sources', {});
        expect(r.isError, r.text).toBe(false);
        const q = catalogQueries().at(-1)!;
        expect(q.user).toBe('lightdash-operations');
        expect(q.database).toBe('operations');
    });

    it('sends SET hrx.identity with a §3 token (iss telemetry-mcp, agent true) and SET statement_timeout before the query', async () => {
        const q = catalogQueries().at(-1)!;
        const payload = verifyIdentityToken(identityOf(q), IDENTITY_SECRET);
        expect(payload).toMatchObject({
            v: 1,
            iss: 'telemetry-mcp',
            sub: ANALYST.userUuid,
            email: ANALYST.email,
            org: ORG_UUID,
            project: PROJECT_UUID,
            agent: true,
            sys: false,
            attrs: { telemetry_restricted: false, platform_read: true, platform_write: false, platform_explain: true },
        });
        expect(payload.audit.source).toBe('mcp');
        expect(payload.exp - payload.iat).toBeGreaterThan(0);
        expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
        expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(30);
        expect(q.sets.statement_timeout).toBe('30000');
        // The SET statements ran on the same connection, before the query.
        const sameConn = h.engine.queries.filter((x) => x.connectionId === q.connectionId);
        const setIdx = sameConn.findIndex((x) => /^\s*SET\s+hrx\.identity/i.test(x.sql));
        const qIdx = sameConn.indexOf(q);
        expect(setIdx).toBeGreaterThanOrEqual(0);
        expect(setIdx).toBeLessThan(qIdx);
    });

    it('uses a new connection and a fresh token for every call, and closes it afterwards', async () => {
        await h.call('list_sources', {});
        await h.call('list_sources', {});
        const [a, b] = catalogQueries().slice(-2);
        expect(a!.connectionId).not.toBe(b!.connectionId);
        const ta = verifyIdentityToken(identityOf(a!), IDENTITY_SECRET);
        const tb = verifyIdentityToken(identityOf(b!), IDENTITY_SECRET);
        expect(ta.nonce).not.toBe(tb.nonce);
        await new Promise((r) => setTimeout(r, 300));
        expect(h.engine.openConnections()).toBe(0);
    });
});
