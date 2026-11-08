/**
 * Harness for the HouseRx chart registry acceptance checks.
 *
 * Reads the built static site in chart-registry/dist/ exactly the way the
 * Lightdash backend does (index.json, charts/<slug>/<version>/entry.json,
 * source.tar and dist.tar), and renders an entry's dist bundle in jsdom by
 * playing the host's side of the data-app viz protocol
 * (packages/query-sdk/src/vizContext.ts): answer the iframe's
 * `lightdash:sdk:viz-context-request` with a
 * `lightdash:sdk:data-app-viz-context` message carrying synthetic rows.
 *
 * Contract for entries, so the harness can render them:
 * - dist/index.html loads its code with <script src="./assets/..."> tags only
 *   (the preview iframe's CSP forbids inline scripts);
 * - each script is a classic script (an IIFE bundle: no top-level import or
 *   export), because jsdom does not run ES modules;
 * - the viz draws with DOM or SVG, never canvas (jsdom has no canvas);
 * - every coloured mark carries `data-color="#RRGGBB"` with the colour it is
 *   drawn in, and the marks each test names carry their `data-testid`.
 *
 * jsdom has no layout, so every element reports an 800x400 box here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const DIST = path.join(REPO_ROOT, 'chart-registry/dist');

const backendRequire = createRequire(
    path.join(REPO_ROOT, 'packages/backend/package.json'),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const common: any = backendRequire('@lightdash/common');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { JSDOM, VirtualConsole }: any = backendRequire('jsdom');

export const REGISTRY_SLUGS = [
    'heatmap',
    'state-timeline',
    'stat-sparkline',
    'bar-gauge',
    'histogram',
    'status-grid',
];

export const PALETTE = [
    '#7EB26D',
    '#EAB839',
    '#6ED0E0',
    '#EF843C',
    '#E24D42',
    '#1F78C1',
    '#BA43A9',
    '#705DA0',
];

export const GRAFANA_GREEN = '#73BF69';
export const GRAFANA_RED = '#F2495C';
export const GRAFANA_ORANGE = '#FF9830';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Entry = any;

export const readJson = (relative: string): unknown =>
    JSON.parse(readFileSync(path.join(DIST, relative), 'utf-8'));

export const loadIndex = (
    file: 'index.json' | 'index-next.json' = 'index.json',
): { index: { charts: Entry[] }; dropped: unknown[] } =>
    common.parseChartRegistryIndexTolerant(readJson(file));

export const getEntry = (slug: string): Entry => {
    const { index } = loadIndex();
    const entry = index.charts.find((chart: Entry) => chart.slug === slug);
    if (!entry) {
        throw new Error(
            `registry index has no "${slug}" entry (has: ${index.charts
                .map((c: Entry) => c.slug)
                .join(', ')})`,
        );
    }
    return entry;
};

export const readArtifact = (entry: Entry, kind: 'source' | 'dist'): Buffer => {
    const file = path.join(DIST, entry.artifacts[kind].path);
    if (!existsSync(file)) throw new Error(`missing artifact ${file}`);
    return readFileSync(file);
};

export const sha256 = (buffer: Buffer): string =>
    createHash('sha256').update(buffer).digest('hex');

/** Minimal ustar reader (regular files only; honours pax `path`). */
export const untar = (buffer: Buffer): Map<string, Buffer> => {
    const files = new Map<string, Buffer>();
    let offset = 0;
    let paxPath: string | undefined;
    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const field = (start: number, length: number) =>
            header
                .subarray(start, start + length)
                .toString('utf-8')
                .replace(/\0.*$/s, '');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const type = field(156, 1) || '0';
        const prefix = field(345, 155);
        let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
        const body = buffer.subarray(offset + 512, offset + 512 + size);
        offset += 512 + Math.ceil(size / 512) * 512;
        if (type === 'x') {
            const match = body.toString('utf-8').match(/\d+ path=([^\n]*)\n/);
            paxPath = match?.[1];
            continue;
        }
        if (paxPath) {
            name = paxPath;
            paxPath = undefined;
        }
        if (type === '0' || type === '\0') {
            files.set(name.replace(/^\.\//, ''), Buffer.from(body));
        }
    }
    return files;
};

export const scriptSources = (html: string): string[] =>
    [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(
        (m) => m[1],
    );

export const hasInlineScript = (html: string): boolean =>
    [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].some(
        (m) => !/\bsrc=/.test(m[1]) && m[2].trim().length > 0,
    );

const distPath = (src: string) =>
    path.posix.normalize(path.posix.join('dist', src.replace(/^\.?\//, '')));

const cell = (raw: unknown) => ({
    value: {
        raw,
        formatted: raw === null || raw === undefined ? '' : String(raw),
    },
});

type ConfigOption = { name: string; default: unknown };

export type Rendered = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window: any;
    document: Document;
    root: HTMLElement;
    errors: string[];
    messages: unknown[];
    all: (selector: string) => HTMLElement[];
    one: (selector: string) => HTMLElement;
    close: () => void;
};

const sleep = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Renders a registry entry's dist bundle with synthetic rows keyed by the
 * entry's viz field names (the host maps each field name to a query field
 * id; here the id is the field name). Options default to the declared
 * config option defaults. Resolves once `waitFor` matches, or after 3 s.
 */
export const renderEntry = async (
    slug: string,
    {
        rows,
        options = {},
        waitFor,
    }: {
        rows: Record<string, unknown>[];
        options?: Record<string, unknown>;
        waitFor?: string;
    },
): Promise<Rendered> => {
    const entry = getEntry(slug);
    const files = untar(readArtifact(entry, 'dist'));
    const html = files.get('dist/index.html');
    if (!html) throw new Error(`${slug}: dist.tar has no dist/index.html`);

    const errors: string[] = [];
    const messages: unknown[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e: Error) => errors.push(String(e)));
    const dom = new JSDOM(html.toString('utf-8'), {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: 'http://registry.test/preview/',
        virtualConsole,
    });
    const { window } = dom;
    const { document } = window;

    // No layout in jsdom: give every element an 800x400 box.
    const proto = window.HTMLElement.prototype;
    for (const [prop, value] of [
        ['clientWidth', 800],
        ['clientHeight', 400],
        ['offsetWidth', 800],
        ['offsetHeight', 400],
    ] as const) {
        Object.defineProperty(proto, prop, {
            configurable: true,
            get: () => value,
        });
    }
    const rect = {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 800,
        height: 400,
        right: 800,
        bottom: 400,
        toJSON: () => ({}),
    };
    window.Element.prototype.getBoundingClientRect = () => rect;
    window.ResizeObserver = class {
        private readonly cb: (entries: unknown[]) => void;

        constructor(cb: (entries: unknown[]) => void) {
            this.cb = cb;
        }

        observe(target: unknown) {
            setTimeout(
                () =>
                    this.cb([
                        {
                            target,
                            contentRect: rect,
                            borderBoxSize: [{ inlineSize: 800, blockSize: 400 }],
                            contentBoxSize: [{ inlineSize: 800, blockSize: 400 }],
                        },
                    ]),
                0,
            );
        }

        unobserve() {}

        disconnect() {}
    };
    window.matchMedia =
        window.matchMedia ??
        ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => false,
        }));
    window.addEventListener('error', (e: ErrorEvent) =>
        errors.push(String(e.error ?? e.message)),
    );

    const configOptions: ConfigOption[] = entry.vizSchema.configOptions ?? [];
    const defaults = Object.fromEntries(
        configOptions.map((o) => [o.name, o.default]),
    );
    const fieldNames: string[] = entry.vizSchema.fields.map(
        (f: { name: string }) => f.name,
    );
    const context = {
        type: 'lightdash:sdk:data-app-viz-context',
        fieldMapping: Object.fromEntries(fieldNames.map((n) => [n, n])),
        fields: Object.fromEntries(
            entry.vizSchema.fields.map((f: { name: string; label: string }) => [
                f.name,
                { label: f.label },
            ]),
        ),
        rows: rows.map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([k, v]) => [k, cell(v)]),
            ),
        ),
        options: { ...defaults, ...options },
        colorPalette: PALETTE,
        seriesColors: {},
        valueColors: {},
        pivotDetails: null,
        renderId: 'acceptance-1',
    };
    const push = () =>
        window.dispatchEvent(
            new window.MessageEvent('message', { data: context }),
        );
    window.addEventListener('message', (event: MessageEvent) => {
        messages.push(event.data);
        const data = event.data as { type?: string } | undefined;
        if (data?.type === 'lightdash:sdk:viz-context-request') push();
    });

    for (const src of scriptSources(html.toString('utf-8'))) {
        const code = files.get(distPath(src));
        if (!code) throw new Error(`${slug}: dist.tar has no ${distPath(src)}`);
        try {
            window.eval(code.toString('utf-8'));
        } catch (e) {
            errors.push(`script ${src} threw: ${String(e)}`);
        }
    }
    await sleep(50);
    push();

    const all = (selector: string) =>
        [...document.querySelectorAll(selector)] as HTMLElement[];
    const deadline = Date.now() + 3000;
    // eslint-disable-next-line no-await-in-loop
    while (waitFor && all(waitFor).length === 0 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
    }
    await sleep(30);

    return {
        window,
        document,
        root: (document.getElementById('root') ?? document.body) as HTMLElement,
        errors,
        messages,
        all,
        one: (selector: string) => {
            const found = all(selector);
            if (found.length !== 1) {
                throw new Error(
                    `expected one ${selector}, found ${found.length}: ${document.body.innerHTML.slice(0, 2000)}`,
                );
            }
            return found[0];
        },
        close: () => window.close(),
    };
};

export const colorOf = (el: Element): string =>
    (el.getAttribute('data-color') ?? '').toUpperCase();

export const minutes = (n: number): string =>
    new Date(Date.UTC(2026, 10, 8, 12, n, 0)).toISOString();
