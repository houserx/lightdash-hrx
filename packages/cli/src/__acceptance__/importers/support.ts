/* eslint-disable */
// @ts-nocheck
// Shared helpers for the importer CLI acceptance tests (protected). Loosely typed on purpose:
// they drive commands that later sessions build.
//
// Output layout the tests rely on (the CLI writes it under --out):
//   grafana-dashboard / perses-dashboard:
//     dashboards/<dashboard slug>.yml       dashboard as code
//     charts/<chart slug>.yml               SQL chart as code, one per chart panel
//     reports/<dashboard slug>/IMPORT-REPORT.md
//     lightdash.config.yml                  only when the dashboards define parameters
//     import-summary.json
//   grafana-alerts:
//     alert-rules/<slug>.yml, contact-points/<slug>.yml,
//     notification-routes/notification-routes.yml, ROUTING-FIXES.md, IMPORT-REPORT.md,
//     import-summary.json
// import-summary.json is {command, warnings: {total, byCode: {<code>: n}}, todos, files: [...]}.
import {
    chartAsCodeSchema,
    dashboardAsCodeSchema,
    generateSlug,
    lightdashProjectConfigSchema,
    routeAlert,
    validateAlertingAsCode,
} from '@lightdash/common';
import Ajv from 'ajv';
import * as yaml from 'js-yaml';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ajv as uploadAjv } from '../../ajv';

export * from '../../../../common/src/__acceptance__/importers/support';
export { generateSlug, routeAlert, validateAlertingAsCode };

export const CLI_ROOT = path.resolve(__dirname, '../../..');
export const REPO_ROOT = path.resolve(CLI_ROOT, '../..');
export const FIXTURES = path.join(__dirname, 'fixtures');
export const GRAFANA_CONFIG = path.join(FIXTURES, 'grafana_config');
export const TF = path.join(FIXTURES, 'terraform');
export const PERSES = path.join(FIXTURES, 'perses');
export const DATASOURCES_TF = path.join(TF, 'grafana_data_sources.tf');

export type CliResult = { code: number | null; stdout: string; stderr: string };

/** Runs the real CLI from source: `node --import tsx packages/cli/src/index.ts <args>`. */
export const runCli = (args: string[], options: { cwd?: string; home?: string } = {}) =>
    new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            CI: 'true',
            FORCE_COLOR: '0',
            NO_COLOR: '1',
            LIGHTDASH_CLI_TELEMETRY_DISABLED: 'true',
        };
        for (const name of [
            'LIGHTDASH_API_KEY',
            'LIGHTDASH_URL',
            'LIGHTDASH_PROJECT',
            'LIGHTDASH_PROXY_AUTHORIZATION',
            'LIGHTDASH_AGENT_CONNECTION',
        ]) {
            delete env[name];
        }
        if (options.home) env.HOME = options.home;
        const child = spawn(
            process.execPath,
            ['--import', require.resolve('tsx'), path.join(CLI_ROOT, 'src/index.ts'), ...args],
            { cwd: options.cwd ?? REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`CLI timed out: ${args.join(' ')}`));
        }, 120_000);
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });

/** A fresh directory under the repo's gitignored tmp/, removed by cleanup(). */
export const tempDir = async () => {
    const base = path.join(REPO_ROOT, 'tmp', 'importers-acceptance');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, 'run-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

const walk = (root: string, rel = ''): string[] => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).flatMap((name) => {
        const r = rel ? `${rel}/${name}` : name;
        return statSync(path.join(root, r)).isDirectory() ? walk(root, r) : [r];
    });
};

/** Reads what an import wrote. Paths are relative to --out, with forward slashes. */
export const readTree = (out: string) => {
    const files = walk(out).sort();
    const text = (rel: string) => readFileSync(path.join(out, rel), 'utf8');
    const doc = (rel: string) => yaml.load(text(rel)) as any;
    const inFolder = (folder: string) =>
        files
            .filter((f) => f.startsWith(`${folder}/`) && /\.ya?ml$/.test(f))
            .map((f) => ({ file: f, doc: doc(f) }));
    return {
        out,
        files,
        text,
        doc,
        exists: (rel: string) => existsSync(path.join(out, rel)),
        dashboards: () => inFolder('dashboards'),
        charts: () => inFolder('charts'),
        chartBySlug: (slug: string) => inFolder('charts').find((c) => c.doc.slug === slug)?.doc,
        alertRules: () => inFolder('alert-rules'),
        contactPoints: () => inFolder('contact-points'),
        routes: () => doc('notification-routes/notification-routes.yml'),
        summary: () => JSON.parse(text('import-summary.json')),
        report: (dashboardSlug: string) => text(`reports/${dashboardSlug}/IMPORT-REPORT.md`),
        projectConfig: () => doc('lightdash.config.yml'),
    };
};

export type Imported = ReturnType<typeof readTree> & { result: CliResult; input: string };

/**
 * Writes the given Grafana dashboards (objects, written as JSON files) or uses the given file
 * paths, runs `lightdash import grafana-dashboard <files...> --out <dir> [extra...]` and returns
 * the result and the output tree. Fails the test when the command does not exit 0, unless
 * `expectFailure` is set.
 */
export const importGrafanaDashboards = async (
    dashboards: Array<object | string>,
    extra: string[] = [],
    options: { expectFailure?: boolean } = {},
): Promise<Imported & { cleanup: () => Promise<void> }> => {
    const { dir, cleanup } = await tempDir();
    const input = path.join(dir, 'input');
    await mkdir(input, { recursive: true });
    const files: string[] = [];
    for (const [i, d] of dashboards.entries()) {
        if (typeof d === 'string') {
            files.push(d);
        } else {
            const file = path.join(input, `dashboard-${i + 1}.json`);
            await writeFile(file, JSON.stringify(d, null, 2));
            files.push(file);
        }
    }
    const out = path.join(dir, 'out');
    const result = await runCli(['import', 'grafana-dashboard', ...files, '--out', out, ...extra], {
        home: dir,
    });
    if (!options.expectFailure && result.code !== 0) {
        throw new Error(`grafana-dashboard exited ${result.code}\n${result.stdout}\n${result.stderr}`);
    }
    return { ...readTree(out), result, input, cleanup };
};

export const importPerses = async (
    files: string[],
    extra: string[] = [],
    options: { expectFailure?: boolean } = {},
) => {
    const { dir, cleanup } = await tempDir();
    const out = path.join(dir, 'out');
    const result = await runCli(['import', 'perses-dashboard', ...files, '--out', out, ...extra], {
        home: dir,
    });
    if (!options.expectFailure && result.code !== 0) {
        throw new Error(`perses-dashboard exited ${result.code}\n${result.stdout}\n${result.stderr}`);
    }
    return { ...readTree(out), result, input: dir, cleanup };
};

/** Terraform input: a fixture path, or `{ name, text }` written to a temp file. */
export type TfInput = string | { name: string; text: string };

/**
 * Runs `lightdash import grafana-alerts --rules <tf...> --contact-points <tf> --policy <tf>
 * --out <dir> [--locals <tf...>] [extra...]`. Other options the tests use: --datasources <tf>
 * (grafana_data_sources.tf), --folders <tf> (grafana_folders.tf), --routing-decisions <yml>,
 * --no-routing-fixes.
 */
export const importGrafanaAlerts = async (
    input: { rules: TfInput[]; contactPoints: TfInput; policy: TfInput; locals?: TfInput[]; extra?: string[] },
    options: { expectFailure?: boolean } = {},
) => {
    const { dir, cleanup } = await tempDir();
    const tfDir = path.join(dir, 'tf');
    await mkdir(tfDir, { recursive: true });
    const materialize = async (tf: TfInput) => {
        if (typeof tf === 'string') return tf;
        const file = path.join(tfDir, tf.name);
        await writeFile(file, tf.text);
        return file;
    };
    const rules = [];
    for (const r of input.rules) rules.push(await materialize(r));
    const locals = [];
    for (const l of input.locals ?? []) locals.push(await materialize(l));
    const out = path.join(dir, 'out');
    const args = [
        'import',
        'grafana-alerts',
        '--rules',
        ...rules,
        '--contact-points',
        await materialize(input.contactPoints),
        '--policy',
        await materialize(input.policy),
        '--out',
        out,
        ...(locals.length ? ['--locals', ...locals] : []),
        ...(input.extra ?? []),
    ];
    const result = await runCli(args, { home: dir });
    if (!options.expectFailure && result.code !== 0) {
        throw new Error(`grafana-alerts exited ${result.code}\n${result.stdout}\n${result.stderr}`);
    }
    return { ...readTree(out), result, input: dir, tfDir, cleanup };
};

/** The full fixture rule set: every rule group file, plus the trimmed locals and datasources. */
export const FIXTURE_RULE_FILES = [
    ...readdirSync(TF)
        .filter((f) => /^grafana_rule_groups_.*\.tf$/.test(f) || f === 'grafana_lb_rules.tf')
        .sort()
        .map((f) => path.join(TF, f)),
];
export const FIXTURE_ALERT_EXTRA = [
    '--locals',
    path.join(TF, 'locals.tf'),
    '--folders',
    path.join(TF, 'grafana_folders.tf'),
    '--datasources',
    DATASOURCES_TF,
];
export const importFixtureAlerts = (extra: string[] = []) =>
    importGrafanaAlerts({
        rules: FIXTURE_RULE_FILES,
        contactPoints: path.join(TF, 'grafana_contact_points.tf'),
        policy: path.join(TF, 'grafana_notification_policy.tf'),
        extra: [...FIXTURE_ALERT_EXTRA, ...extra],
    });

/** Every fixture dashboard JSON, sorted. */
export const fixtureDashboards = () =>
    walk(GRAFANA_CONFIG)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(GRAFANA_CONFIG, f));

// ------------------------------------------------------------------- validation
// The same schemas, with the same Ajv options, that `lightdash lint` and upload use.
let chartValidator: any;
let dashboardValidator: any;
const errorsOf = (validate: any) =>
    JSON.stringify((validate.errors ?? []).filter((e: any) => e.keyword !== 'if'), null, 1);

export const validateChart = (doc: unknown) => {
    chartValidator ??= uploadAjv.compile(chartAsCodeSchema);
    const valid = chartValidator(structuredClone(doc));
    return { valid, errors: valid ? '' : errorsOf(chartValidator) };
};
export const validateDashboard = (doc: unknown) => {
    dashboardValidator ??= uploadAjv.compile(dashboardAsCodeSchema);
    const valid = dashboardValidator(structuredClone(doc));
    return { valid, errors: valid ? '' : errorsOf(dashboardValidator) };
};
let projectConfigValidator: any;
export const validateProjectConfig = (doc: unknown) => {
    projectConfigValidator ??= new Ajv({ strict: false, allErrors: true }).compile(
        lightdashProjectConfigSchema,
    );
    const valid = projectConfigValidator(structuredClone(doc));
    return { valid, errors: valid ? '' : JSON.stringify(projectConfigValidator.errors) };
};
export const expectValidChart = (doc: unknown) => {
    const { valid, errors } = validateChart(doc);
    expect(errors).toBe('');
    expect(valid).toBe(true);
};
export const expectValidDashboard = (doc: unknown) => {
    const { valid, errors } = validateDashboard(doc);
    expect(errors).toBe('');
    expect(valid).toBe(true);
};
export const expectValidAlerting = (doc: unknown) => {
    const result = validateAlertingAsCode(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
};

// ----------------------------------------------------------- synthetic dashboards
export const PROM_DS = { type: 'prometheus', uid: 'tmTXpZC4k' };
export const LOKI_DS = { type: 'loki', uid: 'GA4WkvzSz' };
export const CW_DS = { type: 'cloudwatch', uid: 'JOxT6xE4z' };

let panelId = 100;
export const promTarget = (expr = 'sum(rate(http_requests_total[5m]))', extra = {}) => ({
    refId: 'A',
    datasource: PROM_DS,
    expr,
    range: true,
    ...extra,
});

/** A panel of the given Grafana type with one Prometheus target. */
export const panel = (type: string, title: string, gridPos: object, extra: object = {}) => ({
    id: (panelId += 1),
    type,
    title,
    gridPos,
    datasource: PROM_DS,
    targets: [promTarget()],
    fieldConfig: { defaults: {}, overrides: [] },
    options: {},
    ...extra,
});

export const BUILTIN_ANNOTATION = {
    builtIn: 1,
    datasource: { type: 'grafana', uid: '-- Grafana --' },
    enable: true,
    hide: true,
    iconColor: 'rgba(0, 211, 255, 1)',
    name: 'Annotations & Alerts',
    type: 'dashboard',
};

/** A minimal Grafana dashboard (schemaVersion 39) with the given panels and overrides. */
export const grafanaDashboard = (title: string, panels: object[], extra: object = {}) => ({
    uid: `syn-${generateSlug(title)}`,
    title,
    schemaVersion: 39,
    version: 1,
    editable: true,
    time: { from: 'now-6h', to: 'now' },
    refresh: '',
    timezone: 'utc',
    tags: [],
    links: [],
    templating: { list: [] },
    annotations: { list: [BUILTIN_ANNOTATION] },
    panels,
    ...extra,
});

/** Chart tiles of a dashboard doc with the chart each one references. */
export const chartTiles = (tree: ReturnType<typeof readTree>, dashboardDoc: any) =>
    dashboardDoc.tiles
        .filter((t: any) => t.type === 'sql_chart')
        .map((t: any) => ({ tile: t, chart: tree.chartBySlug(t.properties.chartSlug) }));

export const tileByTitle = (dashboardDoc: any, title: string) =>
    dashboardDoc.tiles.find(
        (t: any) => t.properties?.title === title || t.properties?.text === title || t.properties?.chartName === title,
    );

/** Rectangles overlap (same tab). */
export const overlaps = (a: any, b: any) =>
    (a.tabSlug ?? null) === (b.tabSlug ?? null) &&
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h;
