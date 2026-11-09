// ENG-1799 demo: `pnpm -F eng-1799-demo video [--scenes-dir <dir>] [--out <dir>] [--music <file>]`
//
//   --scenes-dir  default demo/eng-1799/out/scenes; holds <scene-id>/video.webm for the eight walkthrough scenes
//   --out         default demo/eng-1799/out; gets eng-1799-demo.mp4, thumbnail.png and CHAPTERS.md
//   --music       a music file supplied by the person rendering the video (the demo never ships audio of its own)
//
// The video opens on a title card ("Lightdash for HouseRx operations"), then plays the eight scene recordings in
// walkthrough order, each with a plain-language caption in the lower third, and ends on an end card. Neighbouring
// segments crossfade for XFADE_SECONDS. The output is one H.264 (yuv420p) 1920x1080 30 fps MP4 made with ffmpeg from
// ffmpeg-static, plus <out>/CHAPTERS.md ("<mm:ss> <title>", one line per chapter: title card, eight scenes, end card)
// and <out>/thumbnail.png (1920x1080: the incident scene's closing frame under a title band).
// Every frame of every scene is used. When the scenes together run longer than MAX_SCENES_SECONDS, the whole video is
// sped up by one uniform factor so it stays inside the 2-4 minute budget. Without --music the MP4 has no audio track.
// With --music the file is checked first (it must exist and be readable), then becomes one AAC stereo track: looped if
// it is shorter than the video, cut to the video's length, faded in over MUSIC_FADE_IN_SECONDS and out over
// MUSIC_FADE_OUT_SECONDS. The repo never ships or downloads audio; the music is whatever the person rendering supplies.
// Relative paths resolve against the directory pnpm was started from.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEMO = path.resolve(__dirname, '..');

const TITLE = 'Lightdash for HouseRx operations';
const SUBTITLE = 'Dashboards, alerts, investigation, AI questions and safe writes, in one place';
const END_TITLE = 'Lightdash for HouseRx operations';
const END_SUBTITLE = 'ENG-1799 demo - synthetic data on a local stack';

/** Walkthrough order (walkthrough/<scene-id>.spec.ts), each with its chapter title and lower-third caption. */
const SCENES = [
    { id: '01-sign-in', chapter: 'Sign in and the Pharmacy Ops overview', caption: 'Sign in and open the Pharmacy Ops overview, refreshing on its own' },
    { id: '02-incident', chapter: 'An incident starts', caption: 'The fill queue backs up: the backlog crosses its line and turns red' },
    { id: '03-alert-fires', chapter: 'The alert fires', caption: 'The backlog alert fires and the on-call page arrives in incident.io' },
    { id: '04-service-health', chapter: 'Service health: logs and traces', caption: 'Error logs and a trace show the slow shipping label service' },
    { id: '05-investigate', chapter: 'Investigate with an ad hoc query', caption: 'Ask an ad hoc question of the metrics and logs, then save it as a chart' },
    { id: '06-ai-question', chapter: 'Ask the AI assistant', caption: 'An AI assistant answers a question with a live query through telemetry-mcp' },
    { id: '07-write-mode', chapter: 'Write Mode on the Platform Database', caption: 'Write Mode: preview the change, type COMMIT to apply it, and see it audited' },
    { id: '08-recovery', chapter: 'Recovery', caption: 'The backlog clears, the alert resolves and incident.io is told' },
] as const;
const END_CHAPTER = 'End card';
/** The thumbnail is this scene's closing frame (the incident: the backlog stat has turned red by then). */
const THUMBNAIL_SCENE = '02-incident';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
/** Longest the joined scenes may run (s); leaves room inside 4 minutes for title and end cards. */
const MAX_SCENES_SECONDS = 225;
const TITLE_SECONDS = 4;
const END_SECONDS = 4;
/** Crossfade between neighbouring segments (title card, scenes, end card). */
const XFADE_SECONDS = 0.75;
const MAX_SECONDS = 240;
/** Light cards with dark text, like the Lightdash UI. A dark card would average out, mid-fade, to a dark blue scene. */
const CARD_COLOUR = '0xf5f6fa';
const CARD_TEXT = '0x14213d';
const CARD_SUBTEXT = '0x4a5068';
const FONT_CANDIDATES = [
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];
/** Shorter than this the video is under 2 minutes; it is still built, with a warning. */
const MIN_SECONDS = 120;
const THREADS = '2';
const MUSIC_FADE_IN_SECONDS = 3;
const MUSIC_FADE_OUT_SECONDS = 4;

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

/** Quote a value for a filter option and then for the filtergraph (ffmpeg's two escaping levels). */
function filterValue(v: string): string {
    const option = `'${v.replace(/'/g, "'\\''")}'`;
    return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** drawtext font option: a known system font file when there is one, else fontconfig's default sans. */
function fontOption(): string {
    const file = FONT_CANDIDATES.find((f) => existsSync(f));
    return file ? `fontfile=${filterValue(file)}` : 'font=Sans';
}

function drawtext(font: string, text: string, size: number, y: string, colour = 'white'): string {
    return `drawtext=${font}:expansion=none:text=${filterValue(text)}:fontsize=${size}:fontcolor=${colour}:x=(w-tw)/2:y=${y}`;
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function resolveFromInvocation(p: string): string {
    return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

/** The --music file, resolved: refused unless it is an existing, readable, non-empty regular file. */
function musicFile(arg: string): string {
    if (!arg.trim()) throw new Error('--music needs a file: the path to a music file you are licensed to use');
    const file = resolveFromInvocation(arg);
    if (!existsSync(file)) throw new Error(`--music file not found: ${file}`);
    const st = statSync(file);
    if (!st.isFile()) throw new Error(`--music is not a file: ${file}`);
    try {
        accessSync(file, constants.R_OK);
    } catch {
        throw new Error(`--music file is not readable: ${file}`);
    }
    if (st.size === 0) throw new Error(`--music file is empty: ${file}`);
    return file;
}

function main(): void {
    const { values } = parseArgs({
        options: {
            'scenes-dir': { type: 'string' },
            out: { type: 'string' },
            music: { type: 'string' },
        },
    });
    // --music is checked before anything else, so a wrong music path is the first thing reported
    const music = values.music === undefined ? undefined : musicFile(values.music);
    const scenesDir = values['scenes-dir'] ? resolveFromInvocation(values['scenes-dir']) : path.join(DEMO, 'out', 'scenes');
    const outDir = values.out ? resolveFromInvocation(values.out) : path.join(DEMO, 'out');

    const clips = SCENES.map((scene) => path.join(scenesDir, scene.id, 'video.webm'));
    const missing = clips.filter((f) => !existsSync(f) || statSync(f).size === 0);
    if (missing.length) {
        throw new Error(`missing scene recordings (run the walkthrough first):\n${missing.map((f) => `  ${f}`).join('\n')}`);
    }

    const bin = ffmpegBinary();
    const durations = clips.map((f) => durationSeconds(bin, f));
    const total = durations.reduce((a, b) => a + b, 0);
    const speed = total > MAX_SCENES_SECONDS ? total / MAX_SCENES_SECONDS : 1;
    SCENES.forEach((scene, i) => log(`${scene.id}: ${durations[i].toFixed(1)} s`));
    log(`scenes total ${total.toFixed(1)} s${speed > 1 ? `, sped up x${speed.toFixed(3)} to ${MAX_SCENES_SECONDS} s` : ''}`);

    // Segments in play order: title card, the eight scenes, end card. Every segment is cut to an exact length so the
    // crossfade offsets (and the chapter times) are exact.
    const lengths = [TITLE_SECONDS, ...durations.map((d) => d / speed), END_SECONDS];
    const starts: number[] = [0];
    for (let i = 1; i < lengths.length; i++) starts.push(starts[i - 1] + lengths[i - 1] - XFADE_SECONDS);
    const videoSeconds = starts[starts.length - 1] + lengths[lengths.length - 1];
    if (videoSeconds > MAX_SECONDS) throw new Error(`the video would run ${videoSeconds.toFixed(1)} s, over ${MAX_SECONDS} s`);
    if (videoSeconds < MIN_SECONDS) log(`warning: the video is ${videoSeconds.toFixed(1)} s, under ${MIN_SECONDS} s`);

    const font = fontOption();
    const fixLength = (seconds: number) =>
        `fps=${FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=2,trim=duration=${seconds.toFixed(6)},setpts=PTS-STARTPTS,settb=AVTB`;
    const card = (input: number, title: string, subtitle: string, seconds: number, label: string) =>
        `[${input}:v:0]${drawtext(font, title, 96, '(h/2)-130', CARD_TEXT)},${drawtext(font, subtitle, 44, '(h/2)+30', CARD_SUBTEXT)},${fixLength(seconds)}[${label}]`;
    const scenes = clips.map(
        (_, i) =>
            `[${i + 1}:v:0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
            `setpts=(PTS-STARTPTS)/${speed.toFixed(6)},` +
            // lower-third caption: a dark band with the scene's plain-language caption
            `drawbox=x=0:y=ih-220:w=iw:h=120:color=black@0.65:t=fill,` +
            `${drawtext(font, SCENES[i].caption, 48, 'h-160-(th/2)')},` +
            `${fixLength(lengths[i + 1])}[s${i + 1}]`,
    );
    const segs = lengths.length;
    const chains = [
        card(0, TITLE, SUBTITLE, TITLE_SECONDS, 's0'),
        ...scenes,
        card(segs - 1, END_TITLE, END_SUBTITLE, END_SECONDS, `s${segs - 1}`),
    ];
    let last = 's0';
    for (let i = 1; i < segs; i++) {
        const next = i === segs - 1 ? 'out' : `x${i}`;
        chains.push(`[${last}][s${i}]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${starts[i].toFixed(6)}[${next}]`);
        last = next;
    }
    if (music) {
        // the music input comes after the end card; looped so it always covers the video, re-timed by sample count (no
        // gaps at the loop points), then cut to the video's exact length. No -shortest: it cuts the audio seconds early.
        const fadeOut = Math.max(videoSeconds - MUSIC_FADE_OUT_SECONDS, 0);
        chains.push(
            `[${segs}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=N/SR/TB,atrim=duration=${videoSeconds.toFixed(6)},` +
                `afade=t=in:st=0:d=${MUSIC_FADE_IN_SECONDS},afade=t=out:st=${fadeOut.toFixed(6)}:d=${MUSIC_FADE_OUT_SECONDS}[aout]`,
        );
    }
    const cardInput = (seconds: number) => ['-f', 'lavfi', '-i', `color=c=${CARD_COLOUR}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${seconds}`];

    // CHAPTERS.md: chapter k starts where the crossfade into it starts (whole seconds; strictly increasing).
    const titles = [TITLE, ...SCENES.map((scene) => scene.chapter), END_CHAPTER];
    const chapterSeconds: number[] = [];
    starts.forEach((t, i) => chapterSeconds.push(i === 0 ? 0 : Math.max(Math.floor(t), chapterSeconds[i - 1] + 1)));
    const chaptersMd = titles.map((title, i) => `${mmss(chapterSeconds[i])} ${title}`).join('\n') + '\n';

    mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'eng-1799-demo.mp4');
    const partial = path.join(outDir, '.eng-1799-demo.partial.mp4');
    rmSync(partial, { force: true });
    try {
        ffmpeg(bin, [
            '-loglevel', 'error', '-y',
            ...cardInput(TITLE_SECONDS),
            ...clips.flatMap((f) => ['-i', f]),
            ...cardInput(END_SECONDS),
            ...(music ? ['-stream_loop', '-1', '-i', music] : []),
            '-filter_complex', chains.join(';'),
            '-map', '[out]',
            ...(music ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-r', String(FPS), '-threads', THREADS, '-filter_complex_threads', THREADS,
            '-movflags', '+faststart',
            '-f', 'mp4', partial,
        ]);
        renameSync(partial, target);
    } finally {
        rmSync(partial, { force: true });
    }
    writeFileSync(path.join(outDir, 'CHAPTERS.md'), chaptersMd);

    // thumbnail.png: one frame of the finished video near the end of the thumbnail scene (before its crossfade out), with the title on a
    // light band across the top (the scene's own caption stays in the lower third).
    const seg = SCENES.findIndex((scene) => scene.id === THUMBNAIL_SCENE) + 1;
    const thumbAt = starts[seg] + Math.max(lengths[seg] - XFADE_SECONDS - 1.5, lengths[seg] / 2);
    const thumb = path.join(outDir, 'thumbnail.png');
    const thumbPartial = path.join(outDir, '.thumbnail.partial.png');
    rmSync(thumbPartial, { force: true });
    try {
        ffmpeg(bin, [
            '-loglevel', 'error', '-y',
            '-ss', thumbAt.toFixed(3), '-i', target,
            '-frames:v', '1',
            '-vf', `drawbox=x=0:y=0:w=iw:h=200:color=${CARD_COLOUR}@0.92:t=fill,${drawtext(font, TITLE, 96, '100-(th/2)', CARD_TEXT)}`,
            '-threads', THREADS,
            '-f', 'image2', '-c:v', 'png', thumbPartial,
        ]);
        renameSync(thumbPartial, thumb);
    } finally {
        rmSync(thumbPartial, { force: true });
    }
    log(`video ${videoSeconds.toFixed(1)} s: title card, ${SCENES.length} captioned scenes, end card, ${XFADE_SECONDS} s crossfades`);
    log(music ? `music from ${music}: AAC, ${MUSIC_FADE_IN_SECONDS} s fade in, ${MUSIC_FADE_OUT_SECONDS} s fade out` : 'no --music: silent');
    log(`wrote ${target}, ${thumb} and ${path.join(outDir, 'CHAPTERS.md')}`);
}

try {
    main();
} catch (err: unknown) {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
