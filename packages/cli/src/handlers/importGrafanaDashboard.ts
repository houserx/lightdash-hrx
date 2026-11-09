import {
    convertGrafanaDashboard,
    ParseError,
    readGrafanaDashboardJson,
    renderGrafanaImportReport,
    type GrafanaDashboardImport,
    type GrafanaDashboardInput,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import GlobalState from '../globalState';
import * as styles from '../styles';

/** The space imported dashboards and charts go to when `--space` is not given. */
export const DEFAULT_GRAFANA_DASHBOARD_SPACE = 'operations';

type ImportGrafanaDashboardOptions = {
    out: string;
    space: string;
    verbose: boolean;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Reads and checks one input file; every failure names the file. */
const readDashboardFile = async (
    file: string,
): Promise<GrafanaDashboardInput> => {
    let contents: string;
    try {
        contents = await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new ParseError(
            `Could not read the Grafana dashboard ${file}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
    }
    let json: unknown;
    try {
        json = JSON.parse(contents);
    } catch (e) {
        throw new ParseError(
            `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    const input = readGrafanaDashboardJson(json);
    if ('error' in input) {
        throw new ParseError(
            `${file} is not a Grafana dashboard: ${input.error}. Export the dashboard JSON from Grafana (Share → Export, or the dashboard API).`,
        );
    }
    return input;
};

// The JSON round trip drops the `undefined` fields the as-code types require (js-yaml can't dump them).
const dumpYaml = (doc: unknown) =>
    yaml.dump(JSON.parse(JSON.stringify(doc)), {
        quotingType: '"',
        noRefs: true,
        lineWidth: -1,
    });

export const importGrafanaDashboardHandler = async (
    files: string[],
    options: ImportGrafanaDashboardOptions,
) => {
    GlobalState.setVerbose(options.verbose);
    const spaceSlug = options.space.trim();
    if (spaceSlug === '') {
        throw new ParseError('--space needs a space slug.');
    }

    // Read and check every file before writing anything.
    const inputs: GrafanaDashboardInput[] = [];
    for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        inputs.push(await readDashboardFile(file));
    }

    const takenDashboardSlugs = new Set<string>();
    const takenChartSlugs = new Set<string>();
    const results: GrafanaDashboardImport[] = inputs.map((input) =>
        convertGrafanaDashboard(input, {
            spaceSlug,
            takenDashboardSlugs,
            takenChartSlugs,
        }),
    );

    const written: string[] = [];
    const write = async (rel: string, contents: string) => {
        const abs = path.join(options.out, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, contents);
        written.push(rel);
        GlobalState.debug(`Wrote ${abs}`);
    };
    for (const result of results) {
        // eslint-disable-next-line no-await-in-loop
        await write(
            `dashboards/${result.dashboard.slug}.yml`,
            dumpYaml(result.dashboard),
        );
        for (const chart of result.charts) {
            // eslint-disable-next-line no-await-in-loop
            await write(`charts/${chart.slug}.yml`, dumpYaml(chart));
        }
        // eslint-disable-next-line no-await-in-loop
        await write(
            `reports/${result.dashboard.slug}/IMPORT-REPORT.md`,
            renderGrafanaImportReport(result),
        );
    }

    const warnings = results.flatMap((r) => r.warnings);
    const byCode: Record<string, number> = {};
    [...warnings]
        .map((w) => w.code)
        .sort()
        .forEach((code) => {
            byCode[code] = (byCode[code] ?? 0) + 1;
        });
    const todos = results.reduce((n, r) => n + r.todos.length, 0);
    const charts = results.reduce((n, r) => n + r.charts.length, 0);
    const summary = {
        command: 'grafana-dashboard',
        warnings: { total: warnings.length, byCode },
        todos,
        files: [...written],
    };
    await write('import-summary.json', `${JSON.stringify(summary, null, 2)}\n`);

    console.info(
        styles.success(
            `Imported ${plural(results.length, 'dashboard')} and ${plural(
                charts,
                'chart',
            )} into ${options.out} (${plural(warnings.length, 'warning')}, ${plural(
                todos,
                'TODO',
            )})`,
        ),
    );
    if (warnings.length > 0 || todos > 0) {
        console.info(
            `See ${path.join(options.out, 'reports')} for each dashboard's IMPORT-REPORT.md.`,
        );
    }
    console.info(
        `Copy the folders into your project's lightdash/ folder and run ${styles.bold(
            'lightdash upload',
        )}.`,
    );
};
