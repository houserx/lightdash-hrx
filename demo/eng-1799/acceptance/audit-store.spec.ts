// demo-audit-store. PROTECTED. Audited Queries need the engine's audit store (fake DynamoDB + S3 in the demo).
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getJson, mintIdentityToken, readStack, withEngine } from './helpers/stack';

test('demo-audit-store: an Audited Query on the Platform Database succeeds, and its audit record is listed by the engine', async () => {
    const stack = readStack();
    const description = `demo acceptance ${randomUUID()}`;
    const token = mintIdentityToken(stack.engine.identitySecret, { attrs: { platform_read: true }, description, ticket: 'ENG-1799' });

    const n = await withEngine(stack, async (c) => {
        await c.query(`SET hrx.identity = '${token}'`);
        return Number((await c.query(`select n from platform_query('select count(*) as n from orders')`)).rows[0].n);
    });
    expect(n).toBeGreaterThanOrEqual(20);

    // without the claim the engine refuses
    await expect(
        withEngine(stack, async (c) => {
            await c.query(`SET hrx.identity = '${mintIdentityToken(stack.engine.identitySecret, { description })}'`);
            return c.query(`select * from platform_query('select 1 as x')`);
        }),
    ).rejects.toThrow(/platform_read/);

    const month = new Date().toISOString().slice(0, 7);
    const page = await getJson<{ items: any[] }>(`${stack.engine.httpUrl}/v1/audit?ticket=ENG-1799`, {
        headers: { authorization: `Bearer ${mintIdentityToken(stack.engine.identitySecret, { attrs: { platform_read: true } })}` },
    });
    const mine = page.items.filter((i) => i.description === description);
    expect(mine.length, 'the Audited Query left one audit record').toBe(1);
    expect(mine[0].database).toBe('platform');
    expect(mine[0].linearTicketId).toBe('ENG-1799');
    expect(String(mine[0].createdAt).slice(0, 7)).toBe(month);
});
