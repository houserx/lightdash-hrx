// demo-scene-05-investigate. PROTECTED.
import { expect, test } from '@playwright/test';
import { expectSceneArtifacts, expectSceneSpecAsserts, ld, lightdashApi, listContent, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-05-investigate: an ad hoc PromQL/LogQL query in Investigate is saved as a chart (recorded)', async () => {
    const stack = readStack();
    await restartScenario(stack, -150, 900);
    const ctx = await lightdashApi(stack);
    const before = new Set((await listContent(ctx, stack.lightdash.projectUuid, 'chart')).map((c) => c.uuid));

    expectSceneSpecAsserts('05-investigate');
    runWalkthrough(['05-investigate']);
    expectSceneArtifacts('05-investigate', 8);

    const added = (await listContent(ctx, stack.lightdash.projectUuid, 'chart')).filter((c) => !before.has(c.uuid));
    expect(added.length, 'the scene saved a new chart').toBeGreaterThan(0);
    const sqls: string[] = [];
    for (const c of added) {
        const saved = await ld<any>(ctx, 'GET', `/api/v1/projects/${stack.lightdash.projectUuid}/sqlRunner/saved/${c.uuid}`).catch(() => null);
        if (saved?.sql) sqls.push(saved.sql);
    }
    expect(sqls.some((s) => /\b(promql|logql|logql_metric)\s*\(/.test(s)), 'the saved chart runs a PromQL or LogQL query').toBe(true);
});
