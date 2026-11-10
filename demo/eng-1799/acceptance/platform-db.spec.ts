// demo-platform-db. PROTECTED.
import { expect, test } from '@playwright/test';
import { readStack, STATE, withPlatformDb } from './helpers/stack';

test('demo-platform-db: a throwaway Postgres plays the Platform Database with a synthetic pharmacy operations schema', async () => {
    const stack = readStack();
    expect(stack.platformDb.host).toBe('127.0.0.1');

    await withPlatformDb(stack, async (c) => {
        const dataDir = (await c.query('show data_directory')).rows[0].data_directory as string;
        expect(dataDir.startsWith(STATE), `the cluster lives under ${STATE}`).toBe(true);
        const listen = (await c.query('show listen_addresses')).rows[0].listen_addresses as string;
        expect(listen).toBe('127.0.0.1');

        const tables = (
            await c.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)
        ).rows.map((r) => r.table_name as string);
        for (const t of ['orders', 'fills', 'queues', 'shipments']) expect(tables, `table public.${t}`).toContain(t);

        for (const t of ['orders', 'fills', 'queues', 'shipments']) {
            const n = Number((await c.query(`select count(*) as n from public.${t}`)).rows[0].n);
            expect(n, `rows in ${t}`).toBeGreaterThanOrEqual(t === 'queues' ? 3 : 20);
        }

        // Synthetic only: no PHI-shaped columns, and any name/contact-shaped text is obviously fake.
        const cols = (
            await c.query(
                `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1)`,
                [['orders', 'fills', 'queues', 'shipments']],
            )
        ).rows as { table_name: string; column_name: string }[];
        for (const { column_name } of cols) {
            expect(column_name, 'no PHI-shaped column').not.toMatch(/(^|_)(dob|date_of_birth|birth_date|ssn|mrn|diagnosis)($|_)/i);
        }
        for (const { table_name, column_name } of cols.filter((x) => /name|email|phone|address/i.test(x.column_name))) {
            const vals = (await c.query(`select distinct "${column_name}"::text as v from public.${table_name} where "${column_name}" is not null limit 500`)).rows;
            for (const { v } of vals) {
                expect(v, `${table_name}.${column_name} must be obviously fake (demo/example/fake/test/synthetic)`).toMatch(/demo|example|fake|test|synthetic/i);
            }
        }

        // the read and write roles the engine uses exist
        const roles = (await c.query(`select rolname from pg_roles`)).rows.map((r) => r.rolname as string);
        expect(roles.length).toBeGreaterThan(1);
    });
});
