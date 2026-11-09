// ENG-1799 demo: `pnpm -F eng-1799-demo video [--scenes-dir <dir>] [--out <dir>] [--music <file>]`
//
//   --scenes-dir  default demo/eng-1799/out/scenes; holds <scene-id>/video.webm for the eight walkthrough scenes
//   --out         default demo/eng-1799/out; gets eng-1799-demo.mp4
//   --music       a music file supplied by the person rendering the video (the demo never ships audio of its own)
//
// The eight scene recordings are joined in walkthrough order into one H.264 (yuv420p) 1920x1080 30 fps MP4 with
// ffmpeg from ffmpeg-static. Every frame of every scene is used. When the scenes together run longer than
// MAX_SCENES_SECONDS, the whole video is sped up by one uniform factor so it stays inside the 2-4 minute budget.
// Without --music the MP4 has no audio track. Relative paths resolve against the directory pnpm was started from.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEMO = path.resolve(__dirname, '..');

/** Walkthrough order (walkthrough/<scene-id>.spec.ts). */
const SCENES = [
    '01-sign-in',
    '02-incident',
    '03-alert-fires',
    '04-service-health',
    '05-investigate',
    '06-ai-question',
    '07-write-mode',
    '08-recovery',
] as const;

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
/** Longest the joined scenes may run (s); leaves room inside 4 minutes for title and end cards. */
const MAX_SCENES_SECONDS = 225;
/** Shorter than this the video is under 2 minutes; it is still built, with a warning. */
const MIN_SECONDS = 120;
const THREADS = '2';

const log = (msg: string) => process.stderr.write(`eng-1799-demo video: ${msg}\n`);

function ffmpegBinary(): string {
    const p = createRequire(path.join(DEMO, 'package.json'))('ffmpeg-static') as string | null;
    if (!p || !existsSync(p)) throw new Error('ffmpeg-static provides no ffmpeg binary: run bash ./init.sh');
    return p;
}

function ffmpeg(bin: string, args: string[]): string {
    const r = spawnSync(bin, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`ffmpeg failed (exit ${r.status}):\n${(r.stderr ?? '').slice(-3000)}`);
    return r.stderr ?? '';
}

/** Duration in seconds. Playwright's webm recordings carry no duration in the header, so decode and read the clock. */
function durationSeconds(bin: string, file: string): number {
    const err = ffmpeg(bin, ['-threads', THREADS, '-i', file, '-map', '0:v:0', '-f', 'null', '-']);
    const times = [...err.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
    const last = times[times.length - 1];
    if (!last) throw new Error(`could not read the duration of ${file}`);
    const s = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
    if (!(s > 0)) throw new Error(`${file} has no video frames`);
    return s;
}

function resolveFromInvocation(p: string): string {
    return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

function main(): void {
    const { values } = parseArgs({
        options: {
            'scenes-dir': { type: 'string' },
            out: { type: 'string' },
            music: { type: 'string' },
        },
    });
    if (values.music !== undefined) {
        throw new Error('--music is not supported by this build yet (it comes with demo-video-music); build without it for a silent video');
    }
    const scenesDir = values['scenes-dir'] ? resolveFromInvocation(values['scenes-dir']) : path.join(DEMO, 'out', 'scenes');
    const outDir = values.out ? resolveFromInvocation(values.out) : path.join(DEMO, 'out');

    const clips = SCENES.map((id) => path.join(scenesDir, id, 'video.webm'));
    const missing = clips.filter((f) => !existsSync(f) || statSync(f).size === 0);
    if (missing.length) {
        throw new Error(`missing scene recordings (run the walkthrough first):\n${missing.map((f) => `  ${f}`).join('\n')}`);
    }

    const bin = ffmpegBinary();
    const durations = clips.map((f) => durationSeconds(bin, f));
    const total = durations.reduce((a, b) => a + b, 0);
    const speed = total > MAX_SCENES_SECONDS ? total / MAX_SCENES_SECONDS : 1;
    SCENES.forEach((id, i) => log(`${id}: ${durations[i].toFixed(1)} s`));
    log(`scenes total ${total.toFixed(1)} s${speed > 1 ? `, sped up x${speed.toFixed(3)} to ${MAX_SCENES_SECONDS} s` : ''}`);
    if (total / speed < MIN_SECONDS) log(`warning: the video is ${(total / speed).toFixed(1)} s, under ${MIN_SECONDS} s`);

    const chains = clips.map(
        (_, i) =>
            `[${i}:v:0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
            `setpts=(PTS-STARTPTS)/${speed.toFixed(6)},fps=${FPS},format=yuv420p[v${i}]`,
    );
    const filter = `${chains.join(';')};${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[out]`;

    mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'eng-1799-demo.mp4');
    const partial = path.join(outDir, '.eng-1799-demo.partial.mp4');
    rmSync(partial, { force: true });
    try {
        ffmpeg(bin, [
            '-loglevel', 'error', '-y',
            ...clips.flatMap((f) => ['-i', f]),
            '-filter_complex', filter,
            '-map', '[out]',
            '-an',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-r', String(FPS), '-threads', THREADS, '-filter_complex_threads', THREADS,
            '-movflags', '+faststart',
            '-f', 'mp4', partial,
        ]);
        renameSync(partial, target);
    } finally {
        rmSync(partial, { force: true });
    }
    log(`wrote ${target}`);
}

try {
    main();
} catch (err: unknown) {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
