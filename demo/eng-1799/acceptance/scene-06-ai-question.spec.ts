// demo-scene-06-ai-question. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expectSceneArtifacts, expectSceneSpecAsserts, OUT, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-06-ai-question: a scripted MCP client asks through telemetry-mcp; the query and result are shown (recorded)', async () => {
    const stack = readStack();
    await restartScenario(stack, -120, 900);
    expectSceneSpecAsserts('06-ai-question');
    runWalkthrough(['06-ai-question']);
    expectSceneArtifacts('06-ai-question', 5);

    const answer = JSON.parse(readFileSync(path.join(OUT, 'scenes', '06-ai-question', 'answer.json'), 'utf8'));
    expect(String(answer.question).length).toBeGreaterThan(5);
    expect(typeof answer.tool).toBe('string');
    expect(String(answer.query).length).toBeGreaterThan(5);
    expect(answer.result.rows.length).toBeGreaterThan(0);
});
