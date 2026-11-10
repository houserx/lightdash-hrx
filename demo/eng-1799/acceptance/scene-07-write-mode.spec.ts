// demo-scene-07-write-mode. PROTECTED.
import { expect, test } from '@playwright/test';
import { auditItems, expectSceneArtifacts, expectSceneSpecAsserts, lightdashApi, platformFingerprint, readStack, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-07-write-mode: Write Mode on the Platform Database: Preview, a confirmed commit, and both in the audit browser (recorded)', async () => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const startedAt = Date.now() - 2_000;
    const before = await platformFingerprint(stack);
    const beforeIds = new Set((await auditItems(ctx, stack)).map((i) => i.id));

    expectSceneSpecAsserts('07-write-mode', 4);
    runWalkthrough(['07-write-mode']);
    expectSceneArtifacts('07-write-mode', 8);

    expect(await platformFingerprint(stack), 'the commit changed the Platform Database').not.toBe(before);
    const writes = (await auditItems(ctx, stack)).filter(
        (i) => !beforeIds.has(i.id) && i.mode === 'write' && new Date(i.createdAt).getTime() >= startedAt,
    );
    expect(writes.length, 'a Preview and a commit were audited').toBeGreaterThanOrEqual(2);
    for (const w of writes) {
        expect(String(w.description).trim().length).toBeGreaterThan(0);
        expect(w.executedByEmail).toBe(stack.demoUser.email);
    }
});
