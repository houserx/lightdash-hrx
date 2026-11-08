/**
 * Builds the HouseRx chart registry into chart-registry/dist/, a static
 * site in exactly the format the Lightdash backend's ChartRegistryClient
 * reads:
 *
 *   index.json, index-next.json           every chart's current entry
 *   charts/<slug>/<version>/entry.json    the immutable per-version snapshot
 *   charts/<slug>/<version>/source.tar    src/... (the files bundled)
 *   charts/<slug>/<version>/dist.tar      dist/index.html + dist/assets/*
 *   charts/<slug>/<version>/screenshot-*.png   when the chart ships any
 *
 * Each chart lives in src/charts/<slug>/: `registry.json` (name,
 * description, version, publishedAt, changelog, tags, icon, vizSchema,
 * preview), `index.ts` (the viz, bundled by esbuild as one classic IIFE
 * script, because the preview CSP forbids inline scripts and the
 * acceptance harness evals classic scripts), and optional
 * `screenshot-*.png` files.
 *
 * Modelled on packages/backend/src/ee/services/AppGenerateService/
 * testFixtures/buildChartRegistryFixture.ts. Every entry is validated with
 * @lightdash/common's own registry parsers, and the index entry is the one
 * parsed back from the per-version snapshot, so the two can never disagree.
 * Tars are deterministic (sorted, fixed mtime and mode), so rebuilding an
 * unchanged version yields byte-identical artifacts and digests.
 */
import {
    CHART_REGISTRY_INDEX_SCHEMA_VERSION,
    chartRegistryIndexSchema,
    isValidDataAppSlug,
    parseChartRegistryIndexTolerant,
    parseChartRegistryVersionSnapshot,
    type ChartRegistryEntry,
    type ChartRegistryIndex,
} from '@lightdash/common';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from 'tar-stream';

const PACKAGE_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);
const CHARTS_DIR = path.join(PACKAGE_ROOT, 'src/charts');
const SHARED_DIR = path.join(PACKAGE_ROOT, 'src/shared');
const OUT_DIR = path.join(PACKAGE_ROOT, 'dist');
const HTML_TEMPLATE = path.join(SHARED_DIR, 'index.html');
const STYLESHEET = path.join(SHARED_DIR, 'style.css');
const REQUIRED_TAG = 'houserx';
const SCREENSHOT_PATTERN = /^screenshot-[A-Za-z0-9_-]+\.png$/;

type ChartManifest = Omit<
    ChartRegistryEntry,
    | 'slug'
    | 'artifacts'
    | 'screenshots'
    | 'thumbnail'
    | 'thumbnailDark'
    | 'channel'
    | 'minLightdashVersion'
> & { minLightdashVersion?: string | null };

type TarFile = { name: string; content: Buffer };

const sha256Hex = (buffer: Buffer): string =>
    createHash('sha256').update(buffer).digest('hex');

const escapeHtml = (text: string): string =>
    text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

/** Packs files into a ustar buffer, sorted by name with a fixed mtime and mode. */
const packTar = (files: TarFile[], mtime: Date): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const packer = pack();
        const chunks: Buffer[] = [];
        packer.on('data', (chunk: Buffer) => chunks.push(chunk));
        packer.on('end', () => resolve(Buffer.concat(chunks)));
        packer.on('error', reject);
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
        const addNext = (i: number): void => {
            if (i >= sorted.length) {
                packer.finalize();
                return;
            }
            packer.entry(
                { name: sorted[i].name, mtime, mode: 0o644, uid: 0, gid: 0 },
                sorted[i].content,
                (err) => {
                    if (err) reject(err);
                    else addNext(i + 1);
                },
            );
        };
        addNext(0);
    });

/** Bundles a chart's index.ts into one classic (IIFE) script. */
const bundleChart = async (
    slug: string,
): Promise<{ code: Buffer; inputs: string[] }> => {
    const result = await build({
        absWorkingDir: PACKAGE_ROOT,
        entryPoints: [path.join(CHARTS_DIR, slug, 'index.ts')],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'none',
        metafile: true,
        write: false,
        logLevel: 'silent',
    });
    const [output] = result.outputFiles;
    return {
        code: Buffer.from(output.contents),
        // Paths relative to the package root; files from node_modules are
        // dependencies, not this chart's source.
        inputs: Object.keys(result.metafile.inputs).filter((input) =>
            input.startsWith('src/'),
        ),
    };
};

const sourceFile = async (relative: string): Promise<TarFile> => ({
    name: relative,
    content: await readFile(path.join(PACKAGE_ROOT, relative)),
});

const buildChart = async (slug: string): Promise<ChartRegistryEntry> => {
    if (!isValidDataAppSlug(slug)) {
        throw new Error(`src/charts/${slug}: not a valid chart type slug`);
    }
    const chartDir = path.join(CHARTS_DIR, slug);
    const manifest = JSON.parse(
        await readFile(path.join(chartDir, 'registry.json'), 'utf-8'),
    ) as ChartManifest;
    if (!manifest.tags?.includes(REQUIRED_TAG)) {
        throw new Error(
            `${slug}: registry.json tags must include "${REQUIRED_TAG}"`,
        );
    }
    if (!manifest.preview?.rows?.length) {
        throw new Error(`${slug}: registry.json must have preview.rows`);
    }
    const publishedAt = new Date(manifest.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) {
        throw new Error(`${slug}: registry.json publishedAt is not a date`);
    }

    const { code, inputs } = await bundleChart(slug);
    const script = `${slug}.js`;
    const html = (await readFile(HTML_TEMPLATE, 'utf-8'))
        .replaceAll('{{name}}', escapeHtml(manifest.name))
        .replaceAll('{{script}}', script);
    const distTar = await packTar(
        [
            { name: 'dist/index.html', content: Buffer.from(html) },
            { name: `dist/assets/${script}`, content: code },
            {
                name: 'dist/assets/style.css',
                content: await readFile(STYLESHEET),
            },
        ],
        publishedAt,
    );
    const sourceNames = new Set([
        ...inputs,
        `src/charts/${slug}/registry.json`,
        'src/shared/index.html',
        'src/shared/style.css',
    ]);
    const sourceTar = await packTar(
        await Promise.all([...sourceNames].map(sourceFile)),
        publishedAt,
    );

    const screenshots = (await readdir(chartDir))
        .filter((name) => SCREENSHOT_PATTERN.test(name))
        .sort();

    const prefix = `charts/${slug}/${manifest.version}`;
    const versionDir = path.join(OUT_DIR, ...prefix.split('/'));
    await mkdir(versionDir, { recursive: true });

    // The per-version snapshot: images as file names, artifacts as digests.
    const snapshot = {
        slug,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        publishedAt: publishedAt.toISOString(),
        tags: manifest.tags,
        changelog: manifest.changelog,
        minLightdashVersion: manifest.minLightdashVersion ?? null,
        vizSchema: manifest.vizSchema,
        preview: manifest.preview,
        screenshots: screenshots.map((fileName) => ({ fileName })),
        icon: manifest.icon ?? null,
        artifacts: {
            source: { sha256: sha256Hex(sourceTar) },
            dist: { sha256: sha256Hex(distTar) },
        },
    };
    // Throws on anything the backend would reject; the index entry is the
    // snapshot as the client resolves it.
    const entry = parseChartRegistryVersionSnapshot(snapshot, {
        slug,
        version: manifest.version,
    });

    await Promise.all([
        writeFile(
            path.join(versionDir, 'entry.json'),
            `${JSON.stringify(snapshot, null, 2)}\n`,
        ),
        writeFile(path.join(versionDir, 'source.tar'), sourceTar),
        writeFile(path.join(versionDir, 'dist.tar'), distTar),
        ...screenshots.map(async (name) =>
            writeFile(
                path.join(versionDir, name),
                await readFile(path.join(chartDir, name)),
            ),
        ),
    ]);
    return entry;
};

const writeIndex = async (
    file: string,
    index: ChartRegistryIndex,
): Promise<void> => {
    const validated = chartRegistryIndexSchema.parse(index);
    const { dropped } = parseChartRegistryIndexTolerant(validated);
    if (dropped.length > 0) {
        throw new Error(`${file}: entries dropped: ${JSON.stringify(dropped)}`);
    }
    await writeFile(
        path.join(OUT_DIR, file),
        `${JSON.stringify(validated, null, 2)}\n`,
    );
};

const main = async (): Promise<void> => {
    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });

    const slugs = (await readdir(CHARTS_DIR, { withFileTypes: true }))
        .filter(
            (dirent) =>
                dirent.isDirectory() &&
                existsSync(path.join(CHARTS_DIR, dirent.name, 'registry.json')),
        )
        .map((dirent) => dirent.name)
        .sort();
    if (slugs.length === 0) throw new Error('no charts under src/charts/');

    const charts: ChartRegistryEntry[] = [];
    for (const slug of slugs) {
        // eslint-disable-next-line no-await-in-loop
        charts.push(await buildChart(slug));
    }

    const generatedAt = new Date().toISOString();
    const index: ChartRegistryIndex = {
        schemaVersion: CHART_REGISTRY_INDEX_SCHEMA_VERSION,
        generatedAt,
        charts,
    };
    // The next channel lists the same charts until one has a pre-release.
    await writeIndex('index.json', index);
    await writeIndex('index-next.json', index);

    process.stdout.write(
        `chart-registry: built ${charts.length} chart(s) into ${path.relative(process.cwd(), OUT_DIR) || '.'}: ${charts
            .map((c) => `${c.slug}@${c.version}`)
            .join(', ')}\n`,
    );
};

main().catch((error: unknown) => {
    process.stderr.write(
        `chart-registry build failed: ${String(error instanceof Error ? error.stack : error)}\n`,
    );
    process.exit(1);
});
