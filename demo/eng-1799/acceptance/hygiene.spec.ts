// demo-hygiene. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, sh } from './helpers/stack';

const BASE = 'f85d1ce60'; // the ENG-1799 integration base this line started from

test('demo-hygiene: no audio, no streaming-site or remote references, no ee/ changes, no committed state', () => {
    const files = sh('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'demo', 'docs/eng-1799']).stdout.split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);

    // the demo's entry points exist and are scanned below
    for (const f of ['demo/eng-1799/up.sh', 'demo/eng-1799/down.sh', 'demo/eng-1799/run-all.sh', 'demo/eng-1799/walkthrough/run.sh', 'docs/eng-1799/demo.md']) {
        expect(files, f).toContain(f);
    }
    const videoBuild = files.filter((f) => /^demo\/eng-1799\/video\/build\.(ts|sh|mjs|js)$/.test(f));
    expect(videoBuild.length, 'demo/eng-1799/video/build.(ts|sh)').toBe(1);
    const buildSrc = readFileSync(path.join(ROOT, videoBuild[0]), 'utf8');
    expect(buildSrc, 'music only comes from --music').toContain('--music');
    expect(buildSrc, 'the build names no audio file of its own').not.toMatch(/['"`][^'"`\s]*\.(mp3|wav|m4a|aac|flac|ogg|opus)['"`]/i);
    expect(buildSrc, 'ffmpeg comes from ffmpeg-static').toContain('ffmpeg-static');

    const audio = files.filter((f) => /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|wma)$/i.test(f));
    expect(audio, 'no audio files').toEqual([]);

    const texts = files.filter((f) => /\.(ts|tsx|js|mjs|cjs|sh|json|ya?ml|md|html|css|sql|toml)$/i.test(f) && !f.includes('/acceptance/'));
    for (const f of texts) {
        const t = readFileSync(path.join(ROOT, f), 'utf8');
        expect(t, `${f}: no streaming-site or downloader references`).not.toMatch(/youtube|youtu\.be|soundcloud|spotify|yt-dlp|youtube-dl/i);
        if (f.startsWith('demo/') && !f.endsWith('.md') && !/package\.json$/.test(f)) {
            const remote = (t.match(/https?:\/\/[^\s'"`)<>]+/g) ?? []).filter(
                (u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|[\w.-]*example\.(com|org|net)|json-schema\.org|www\.w3\.org)([:/]|$)/.test(u),
            );
            expect(remote, `${f}: the demo needs no network`).toEqual([]);
        }
    }

    expect(sh('git', ['ls-files', '--', 'demo/eng-1799/.state', 'demo/eng-1799/out']).stdout.trim(), 'state and output are not committed').toBe('');

    const ee = ['packages/backend/src/ee', 'packages/common/src/ee', 'packages/frontend/src/ee'];
    expect(sh('git', ['merge-base', '--is-ancestor', BASE, 'HEAD']).status, `${BASE} is an ancestor`).toBe(0);
    expect(sh('git', ['diff', '--name-only', BASE, '--', ...ee]).stdout.trim(), 'no ee/ changes').toBe('');
    expect(sh('git', ['status', '--porcelain', '--', ...ee]).stdout.trim(), 'no uncommitted ee/ changes').toBe('');
});
