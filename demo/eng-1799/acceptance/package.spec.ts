// demo-package-workspace. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO, ROOT, sh } from './helpers/stack';

test('demo-package-workspace: eng-1799-demo is a workspace package with typecheck, walkthrough, video and ask scripts', async () => {
    const ws = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).toMatch(/^\s*-\s*'?demo\/eng-1799'?\s*$/m);

    const pkg = JSON.parse(readFileSync(path.join(DEMO, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('eng-1799-demo');
    for (const script of ['typecheck', 'walkthrough', 'video', 'ask']) {
        expect(pkg.scripts?.[script], `package.json script "${script}"`).toBeTruthy();
    }
    expect(pkg.devDependencies?.['ffmpeg-static'], 'ffmpeg-static is a devDependency').toBeTruthy();
    expect(pkg.dependencies?.['ffmpeg-static'], 'ffmpeg-static is not a runtime dependency').toBeUndefined();
    expect(pkg.devDependencies?.['@playwright/test']).toBe('1.63.0');

    // state and output are gitignored
    const ignored = sh('git', ['check-ignore', '-q', 'demo/eng-1799/.state/probe', 'demo/eng-1799/out/probe.mp4']);
    expect(ignored.status, 'demo/eng-1799/.state/ and demo/eng-1799/out/ are gitignored').toBe(0);

    // the lockfile is consistent with every package.json
    const install = sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { timeoutMs: 240_000 });
    expect(install.status, `pnpm install --frozen-lockfile:\n${install.stdout.slice(-2000)}${install.stderr.slice(-2000)}`).toBe(0);

    // tsc over the demo package passes
    const tc = sh('pnpm', ['--fail-if-no-match', '-F', 'eng-1799-demo', 'typecheck'], { timeoutMs: 240_000 });
    expect(tc.status, `pnpm -F eng-1799-demo typecheck:\n${tc.stdout.slice(-3000)}${tc.stderr.slice(-2000)}`).toBe(0);
});
