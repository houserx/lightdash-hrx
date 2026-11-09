// demo-video-build, demo-video-cards-captions, demo-video-thumbnail-chapters, demo-video-music. PROTECTED.
// No stack: the build runs over eight synthetic solid-colour scene clips generated here with ffmpeg-static.
// Checks: run.sh video.spec.ts --grep "<feature id>:"
//
// Pinned interface:
//   pnpm -F eng-1799-demo video [--scenes-dir <dir>] [--out <dir>] [--music <file>]
//     --scenes-dir  default demo/eng-1799/out/scenes; holds <scene-id>/video.webm for the eight scenes
//     --out         default demo/eng-1799/out
//   writes <out>/eng-1799-demo.mp4, <out>/thumbnail.png (or .jpg) and <out>/CHAPTERS.md
//   CHAPTERS.md: one chapter per line, "<mm:ss> <title>" (optionally "- " first): the title card at 00:00
//   ("Lightdash for HouseRx operations"), then the eight scenes in order, then the end card.
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ffmpegPath, LOGDIR, meanVolumeDb, probe, SCENES, sh } from './helpers/stack';

test.describe.configure({ timeout: 900_000 });

const WORK = path.join(LOGDIR, 'video');
const CLIPS = path.join(WORK, 'clips');
const CLIP_SECONDS = 18;
// distinct solid colours, scene 1 blue and scene 2 green (the crossfade check mixes them)
const COLOURS: [number, number, number][] = [
    [0, 0, 255], [0, 255, 0], [255, 0, 255], [255, 128, 0], [0, 255, 255], [128, 0, 0], [255, 255, 0], [0, 0, 128],
];
const hex = ([r, g, b]: number[]) => `0x${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

function makeClips() {
    const stamp = path.join(CLIPS, '.done');
    if (existsSync(stamp)) return;
    rmSync(CLIPS, { recursive: true, force: true });
    SCENES.forEach((scene, i) => {
        const dir = path.join(CLIPS, scene);
        mkdirSync(dir, { recursive: true });
        const r = sh(ffmpegPath(), [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', `color=c=${hex(COLOURS[i])}:s=1920x1080:r=25:d=${CLIP_SECONDS}`,
            '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-threads', '2',
            path.join(dir, 'video.webm'),
        ]);
        expect(r.status, r.stderr).toBe(0);
    });
    sh('touch', [stamp]);
}

const builds = new Map<string, { out: string; status: number | null; log: string }>();
function build(kind: 'silent' | 'music') {
    if (builds.has(kind)) return builds.get(kind)!;
    makeClips();
    const out = path.join(WORK, `out-${kind}`);
    rmSync(out, { recursive: true, force: true });
    const args = ['--silent', '--fail-if-no-match', '-F', 'eng-1799-demo', 'video', '--scenes-dir', CLIPS, '--out', out];
    if (kind === 'music') {
        const music = path.join(WORK, 'synthetic-tone.wav');
        if (!existsSync(music)) {
            const r = sh(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=240', '-ac', '2', music]);
            expect(r.status, r.stderr).toBe(0);
        }
        args.push('--music', music);
    }
    const r = sh('pnpm', args, { timeoutMs: 720_000 });
    const result = { out, status: r.status, log: `${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}` };
    builds.set(kind, result);
    expect(result.status, `video build (${kind}) failed:\n${result.log}`).toBe(0);
    return result;
}

type Chapter = { t: number; title: string };
function chapters(out: string): Chapter[] {
    const md = readFileSync(path.join(out, 'CHAPTERS.md'), 'utf8');
    return md
        .split('\n')
        .map((l) => l.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\*\*)?\s+[-–—:]?\s*(.+?)\s*$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ t: m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]), title: m[4] }));
}

/** Raw RGB of one frame, cropped (x, y, w, h in 1920x1080 space) and scaled to sw x sh. */
function frame(file: string, t: number, crop: [number, number, number, number], [sw, shh]: [number, number]): Buffer {
    const [x, y, w, h] = crop;
    const r = spawnSync(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
        '-vf', `crop=${w}:${h}:${x}:${y},scale=${sw}:${shh}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, String(r.stderr)).toBe(0);
    return r.stdout as Buffer;
}
const mean = (buf: Buffer): [number, number, number] => {
    const s = [0, 0, 0];
    for (let i = 0; i < buf.length; i += 3) for (let c = 0; c < 3; c++) s[c] += buf[i + c];
    const n = buf.length / 3;
    return [s[0] / n, s[1] / n, s[2] / n];
};
const near = (a: number[], b: number[], tol = 45) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
const TOP: [number, number, number, number] = [0, 40, 1920, 400];
const LOWER_THIRD: [number, number, number, number] = [0, 760, 1920, 260];

test('demo-video-build: the scene recordings are joined in order into an H.264 1920x1080 30 fps MP4 of 2-4 minutes, silent without --music', () => {
    const { out } = build('silent');
    const info = probe(path.join(out, 'eng-1799-demo.mp4'));
    expect(info.video?.codec).toBe('h264');
    expect([info.video?.width, info.video?.height]).toEqual([1920, 1080]);
    expect(info.video?.fps).toBe(30);
    expect(info.hasAudio, 'silent without --music').toBe(false);
    const total = SCENES.length * CLIP_SECONDS;
    expect(info.durationS!).toBeGreaterThanOrEqual(120);
    expect(info.durationS!).toBeLessThanOrEqual(240);
    // all of every scene is used: title and end cards add more than the crossfades take away
    expect(info.durationS!).toBeGreaterThanOrEqual(total - SCENES.length * 1.5 + 4);
    expect(info.durationS!).toBeLessThanOrEqual(total + 12);
    // scenes in order: one frame per second, mapped to the scene colours, runs collapsed
    const r = spawnSync(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-i', path.join(out, 'eng-1799-demo.mp4'),
        '-vf', `crop=${TOP[2]}:${TOP[3]}:${TOP[0]}:${TOP[1]},scale=16:4,fps=1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, String(r.stderr)).toBe(0);
    const size = 16 * 4 * 3;
    const seq: number[] = [];
    for (let o = 0; o + size <= r.stdout.length; o += size) {
        const m = mean(r.stdout.subarray(o, o + size));
        const idx = COLOURS.findIndex((c) => near(m, c, 30));
        if (idx >= 0 && seq[seq.length - 1] !== idx) seq.push(idx);
    }
    expect(seq, 'each scene appears once, in order').toEqual(SCENES.map((_, i) => i));
});

test('demo-video-cards-captions: a title card, a lower-third caption on every scene, short crossfades and an end card', () => {
    const { out } = build('silent');
    const mp4 = path.join(out, 'eng-1799-demo.mp4');
    const info = probe(mp4);
    const ch = chapters(out);
    expect(ch.length).toBe(SCENES.length + 2);

    // title card: the first seconds are not scene 1
    expect(near(mean(frame(mp4, 1.0, TOP, [64, 13])), COLOURS[0]), 'title card before scene 1').toBe(false);
    expect(ch[1].t - ch[0].t, 'title card length').toBeGreaterThanOrEqual(2);
    expect(ch[1].t - ch[0].t).toBeLessThanOrEqual(7);
    // end card: the last second is not the last scene
    expect(near(mean(frame(mp4, info.durationS! - 0.8, TOP, [64, 13])), COLOURS[SCENES.length - 1]), 'end card after the last scene').toBe(false);

    // captions: in the middle of each scene the top is the scene colour but the lower third carries text
    SCENES.forEach((_, i) => {
        const t = ch[i + 1].t + CLIP_SECONDS / 2;
        const lower = frame(mp4, t, LOWER_THIRD, [384, 52]);
        let off = 0;
        for (let p = 0; p < lower.length; p += 3) if (!near([lower[p], lower[p + 1], lower[p + 2]], COLOURS[i], 60)) off++;
        expect(off / (lower.length / 3), `caption in the lower third of scene ${i + 1}`).toBeGreaterThan(0.01);
    });

    // crossfade between scene 1 (blue) and scene 2 (green): some frame mixes both
    const r = spawnSync(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, ch[2].t - 2.5)), '-t', '5', '-i', mp4,
        '-vf', `crop=${TOP[2]}:${TOP[3]}:${TOP[0]}:${TOP[1]},scale=32:8,fps=30`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { maxBuffer: 64 * 1024 * 1024 });
    const size = 32 * 8 * 3;
    const frames: [number, number, number][] = [];
    for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(mean(r.stdout.subarray(o, o + size)));
    const mixed = frames.filter(([red, g, b]) => g > 50 && b > 50 && red < 80);
    expect(mixed.length, 'a crossfade mixes scene 1 into scene 2').toBeGreaterThanOrEqual(3);
    expect(mixed.length / 30, 'the crossfade is short (<= 1.5 s)').toBeLessThanOrEqual(1.6);
});

test('demo-video-thumbnail-chapters: a thumbnail and CHAPTERS.md with the title card, the eight scenes in order and the end card', () => {
    const { out } = build('silent');
    const thumb = ['thumbnail.png', 'thumbnail.jpg'].map((f) => path.join(out, f)).find((f) => existsSync(f));
    expect(thumb, 'thumbnail.png or thumbnail.jpg').toBeTruthy();
    const t = probe(thumb!);
    expect([[1920, 1080], [1280, 720]]).toContainEqual([t.video?.width, t.video?.height]);

    const ch = chapters(out);
    expect(ch.length).toBe(SCENES.length + 2);
    expect(ch[0].t).toBe(0);
    expect(ch[0].title).toContain('Lightdash for HouseRx operations');
    for (let i = 1; i < ch.length; i++) expect(ch[i].t, `chapter ${i + 1} starts after chapter ${i}`).toBeGreaterThan(ch[i - 1].t);
    const titles = new Set(ch.map((c) => c.title));
    expect(titles.size, 'every chapter has its own title').toBe(ch.length);
});

test('demo-video-music: --music <file> adds the supplied music, faded in and out; a missing file is refused', () => {
    const missing = sh('pnpm', ['--silent', '--fail-if-no-match', '-F', 'eng-1799-demo', 'video', '--scenes-dir', CLIPS, '--out', path.join(WORK, 'out-missing'), '--music', path.join(WORK, 'no-such-file.wav')], { timeoutMs: 120_000 });
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toMatch(/no-such-file\.wav|music/i);

    const { out } = build('music');
    const mp4 = path.join(out, 'eng-1799-demo.mp4');
    const info = probe(mp4);
    expect(info.hasAudio).toBe(true);
    expect(info.raw).toMatch(/Audio: aac/);
    const d = info.durationS!;
    const middle = meanVolumeDb(mp4, d / 2, 2);
    expect(meanVolumeDb(mp4, 0, 0.4), 'faded in').toBeLessThan(middle - 10);
    expect(meanVolumeDb(mp4, d - 0.5, 0.4), 'faded out').toBeLessThan(middle - 10);
});
