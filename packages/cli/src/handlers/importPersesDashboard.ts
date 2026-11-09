import {
    convertPersesDashboard,
    ParseError,
    readPersesDashboard,
    type GrafanaDashboardImport,
    type PersesDashboardInput,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import GlobalState from '../globalState';
import { writeDashboardImports } from './importGrafanaDashboard';

type ImportPersesDashboardOptions = {
    out: string;
    space: string;
    /** false with --no-tabs. */
    tabs: boolean;
    verbose: boolean;
};

const errorMessage = (e: unknown) =>
    e instanceof Error ? e.message : String(e);

/** Reads and checks one Perses dashboard file (JSON, or YAML); every failure names the file. */
const readPersesFile = async (file: string): Promise<PersesDashboardInput> => {
    let contents: string;
    try {
        contents = await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new ParseError(
            `Could not read the Perses dashboard ${file}: ${errorMessage(e)}`,
        );
    }
    const isJson = path.extname(file).toLowerCase() === '.json';
    let doc: unknown;
    try {
        doc = isJson ? JSON.parse(contents) : yaml.load(contents);
    } catch (e) {
        throw new ParseError(
            `${file} is not valid ${isJson ? 'JSON' : 'YAML'}: ${errorMessage(e)}`,
        );
    }
    const input = readPersesDashboard(doc);
    if ('error' in input) {
        throw new ParseError(
            `${file} is not a Perses dashboard: ${input.error}. Export the dashboard from Perses (percli get dashboard <name> -o yaml, or the dashboard API); use \`lightdash import grafana-dashboard\` for Grafana JSON.`,
        );
    }
    return input;
};

export const importPersesDashboardHandler = async (
    files: string[],
    options: ImportPersesDashboardOptions,
) => {
    GlobalState.setVerbose(options.verbose);
    const spaceSlug = options.space.trim();
    if (spaceSlug === '') {
        throw new ParseError('--space needs a space slug.');
    }

    // Read and check every file before writing anything.
    const inputs: PersesDashboardInput[] = [];
    for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        inputs.push(await readPersesFile(file));
    }

    const takenDashboardSlugs = new Set<string>();
    const takenChartSlugs = new Set<string>();
    const results: GrafanaDashboardImport[] = inputs.map((input) =>
        convertPersesDashboard(input, {
            spaceSlug,
            takenDashboardSlugs,
            takenChartSlugs,
            noTabs: options.tabs === false,
        }),
    );

    await writeDashboardImports(results, {
        out: options.out,
        command: 'perses-dashboard',
    });
};
