/**
 * Feature viz-registry-build: `pnpm -F chart-registry build` writes a
 * deployable static site to chart-registry/dist/ in exactly the format
 * ChartRegistryClient reads: index.json (and index-next.json), and per
 * chart charts/<slug>/<version>/{entry.json,source.tar,dist.tar}, each
 * validated by the same code the Lightdash backend runs.
 */
import { existsSync } from 'node:fs';
import { Script } from 'node:vm';
import path from 'node:path';
import {
    DIST,
    REPO_ROOT,
    common,
    hasInlineScript,
    loadIndex,
    readArtifact,
    readJson,
    scriptSources,
    sha256,
    untar,
    type Entry,
} from './harness';

const { index, dropped } = loadIndex();

describe('registry build output', () => {
    it('writes an index the client parses with nothing dropped', () => {
        expect(dropped).toEqual([]);
        expect(index.charts.length).toBeGreaterThan(0);
        const raw = readJson('index.json') as { schemaVersion: number; generatedAt: string };
        expect(raw.schemaVersion).toBe(1);
        expect(Number.isNaN(Date.parse(raw.generatedAt))).toBe(false);
    });

    it('writes index-next.json for the next channel, listing the same charts', () => {
        const next = loadIndex('index-next.json');
        expect(next.dropped).toEqual([]);
        expect(next.index.charts.map((c: Entry) => c.slug).sort()).toEqual(
            index.charts.map((c: Entry) => c.slug).sort(),
        );
    });

    it('uses valid slugs, one entry per slug, tagged houserx', () => {
        const slugs = index.charts.map((c: Entry) => c.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
        for (const chart of index.charts) {
            expect(common.isValidDataAppSlug(chart.slug)).toBe(true);
            expect(chart.tags).toContain('houserx');
            expect(chart.description.length).toBeGreaterThan(10);
        }
    });

    describe.each(index.charts.map((c: Entry) => [c.slug, c]))(
        '%s',
        (_slug, chart: Entry) => {
            const prefix = `charts/${chart.slug}/${chart.version}`;

            it('publishes an immutable per-version entry.json the client parses', () => {
                const snapshot = common.parseChartRegistryVersionSnapshot(
                    readJson(`${prefix}/entry.json`),
                    { slug: chart.slug, version: chart.version },
                );
                expect(snapshot.vizSchema).toEqual(chart.vizSchema);
                expect(snapshot.artifacts).toEqual(chart.artifacts);
            });

            it('serves artifacts under its version prefix with matching digests', () => {
                for (const kind of ['source', 'dist'] as const) {
                    expect(chart.artifacts[kind].path).toBe(`${prefix}/${kind}.tar`);
                    expect(sha256(readArtifact(chart, kind))).toBe(
                        chart.artifacts[kind].sha256,
                    );
                }
            });

            it('ships a dist.tar the backend install accepts', async () => {
                const { assertValidDistTar } = await import(
                    path.join(
                        REPO_ROOT,
                        'packages/backend/src/ee/services/AppGenerateService/distTarValidation.ts',
                    )
                );
                await expect(
                    assertValidDistTar(readArtifact(chart, 'dist')),
                ).resolves.toBeUndefined();
            });

            it('loads only classic external scripts the preview CSP allows', () => {
                const files = untar(readArtifact(chart, 'dist'));
                const html = files.get('dist/index.html')!.toString('utf-8');
                expect(hasInlineScript(html)).toBe(false);
                const sources = scriptSources(html);
                expect(sources.length).toBeGreaterThan(0);
                for (const src of sources) {
                    expect(src).toMatch(/^\.\/assets\//);
                    const code = files.get(`dist/${src.slice(2)}`);
                    expect(code, src).toBeDefined();
                    // compiles as a classic script: no top-level import/export
                    expect(() => new Script(code!.toString('utf-8'))).not.toThrow();
                }
            });

            it('ships its source under src/', () => {
                const files = untar(readArtifact(chart, 'source'));
                expect([...files.keys()].some((name) => name.startsWith('src/'))).toBe(
                    true,
                );
            });

            it('has a preview with synthetic rows', () => {
                expect(chart.preview?.rows?.length ?? 0).toBeGreaterThan(0);
            });

            it('ships every image it lists', () => {
                for (const image of [
                    ...(chart.screenshots ?? []),
                    ...(chart.thumbnail ? [chart.thumbnail] : []),
                ]) {
                    expect(existsSync(path.join(DIST, image)), image).toBe(true);
                }
            });
        },
    );
});
