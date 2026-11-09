// demo-portal-script. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO, ld, lightdashApi, lightdashSql, listContent, readStack, sqlString } from './helpers/stack';

test('demo-portal-script: a synthetic db-query-portal saved script is imported with `lightdash import portal-scripts` and runs', async () => {
    const scripts = JSON.parse(readFileSync(path.join(DEMO, 'seed', 'portal-scripts.json'), 'utf8'));
    expect(Array.isArray(scripts) && scripts.length >= 1).toBe(true);
    const seedSh = ['seed.sh', 'up.sh'].map((f) => { try { return readFileSync(path.join(DEMO, f), 'utf8'); } catch { return ''; } }).join('\n');
    expect(seedSh, 'the seed uses the CLI import').toMatch(/import\s+portal-scripts/);

    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const charts = await listContent(ctx, stack.lightdash.projectUuid, 'chart');
    for (const s of scripts) {
        const hit = charts.find((c) => c.name === s.title);
        expect(hit, `SQL chart "${s.title}"`).toBeTruthy();
        const saved = await ld<any>(ctx, 'GET', `/api/v1/projects/${stack.lightdash.projectUuid}/sqlRunner/saved/${hit.uuid}`);
        expect(saved.sql.trim(), 'the portal SQL is kept verbatim').toBe(String(s.sql).trim());
    }
    // the first one is Platform Database SQL that runs as an Audited Query on the Operations Project
    const rows = await lightdashSql(ctx, stack.lightdash.projectUuid, `select * from platform_query(${sqlString(String(scripts[0].sql).trim().replace(/;$/, ''))})`, {
        audit: { description: 'demo acceptance: portal script', ticket: 'ENG-1799' },
    });
    expect(rows.length).toBeGreaterThan(0);
});
