// demo-run-all. PROTECTED. No --stack: run-all.sh brings the stack up and down itself.
// The full run is the one check allowed past 3 minutes: it records all eight scenes on a compressed timeline.
// Check: DEMO_INCIDENT_AT=45 DEMO_RECOVERY_AT=150 bash demo/eng-1799/acceptance/run.sh run-all.spec.ts
import { expect, test } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEMO, expectSceneArtifacts, OUT, probe, processesUsingState, SCENES, sh } from './helpers/stack';

test.describe.configure({ timeout: 1_800_000 });

test('demo-run-all: one command runs up, seed, the whole walkthrough, the video build and down', () => {
    const started = Date.now();
    const r = sh('bash', [path.join(DEMO, 'run-all.sh')], { timeoutMs: 1_700_000 });
    expect(r.status, `run-all.sh:\n${r.stdout.slice(-4000)}\n${r.stderr.slice(-3000)}`).toBe(0);

    for (const s of SCENES) {
        expectSceneArtifacts(s, 3);
        expect(statSync(path.join(OUT, 'scenes', s, 'video.webm')).mtimeMs, `${s} was recorded by this run`).toBeGreaterThan(started);
    }
    const mp4 = path.join(OUT, 'eng-1799-demo.mp4');
    expect(statSync(mp4).mtimeMs).toBeGreaterThan(started);
    const info = probe(mp4);
    expect(info.video?.codec).toBe('h264');
    expect([info.video?.width, info.video?.height]).toEqual([1920, 1080]);
    expect(info.video?.fps).toBe(30);
    expect(info.durationS!).toBeGreaterThanOrEqual(60);
    expect(info.hasAudio).toBe(false);
    expect(existsSync(path.join(OUT, 'CHAPTERS.md'))).toBe(true);

    expect(processesUsingState(), 'run-all.sh brought the stack down').toEqual([]);
});
