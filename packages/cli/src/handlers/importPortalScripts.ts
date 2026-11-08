import {
    ChartKind,
    ContentAsCodeType,
    generateSlug,
    MAX_CONTENT_SLUG_LENGTH,
    ParseError,
    truncateSlug,
    type SqlChartAsCode,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import GlobalState from '../globalState';
import * as styles from '../styles';
import { getDownloadFolder } from './contentAsCodePaths';

/** The space imported scripts go to when `--space` is not given. */
export const DEFAULT_PORTAL_SCRIPTS_SPACE = 'platform-saved-sql';

/** The row limit the SQL runner gives a new SQL chart. */
const PORTAL_SCRIPT_CHART_LIMIT = 500;

/**
 * The fields this importer reads from a db-query-portal saved script
 * (`SavedScript` in the portal's api/src/dynamo/savedScripts.ts). The export has more
 * (author, tags, execution counts); those stay behind, so no author identity reaches the YAML.
 */
export type PortalSavedScript = {
    id: string;
    title: string;
    description?: string | null;
    sql: string;
};

const notAnExport = (file: string, reason: string) =>
    new ParseError(
        `${file} is not a db-query-portal saved-scripts export: ${reason}. Export the portal's saved scripts as a JSON array of { id, title, sql } objects.`,
    );

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the parsed JSON is a saved-scripts export and returns its scripts. */
export const parsePortalSavedScripts = (
    json: unknown,
    file: string,
): PortalSavedScript[] => {
    if (!Array.isArray(json)) {
        throw notAnExport(file, 'expected a JSON array of saved scripts');
    }
    return json.map((item, index) => {
        if (!isRecord(item)) {
            throw notAnExport(file, `item ${index + 1} is not an object`);
        }
        const missing = (['id', 'title', 'sql'] as const).filter(
            (key) =>
                typeof item[key] !== 'string' ||
                (item[key] as string).trim() === '',
        );
        if (missing.length > 0) {
            throw notAnExport(
                file,
                `item ${index + 1} has no ${missing.join(', ')}`,
            );
        }
        if (
            item.description !== undefined &&
            item.description !== null &&
            typeof item.description !== 'string'
        ) {
            throw notAnExport(
                file,
                `item ${index + 1} has a description that is not text`,
            );
        }
        return {
            id: item.id as string,
            title: item.title as string,
            description: item.description as string | null | undefined,
            sql: item.sql as string,
        };
    });
};

// Leaves room for a "-<n>" suffix under the content-as-code slug limit.
const SLUG_BASE_LENGTH = MAX_CONTENT_SLUG_LENGTH - 8;

/**
 * Turns saved scripts into SQL charts, in the export's order. Scripts with the same title
 * get `-2`, `-3`, ... after the first one's slug.
 */
export const portalScriptsToSqlCharts = (
    scripts: PortalSavedScript[],
    spaceSlug: string,
): SqlChartAsCode[] => {
    const used = new Set<string>();
    return scripts.map((script) => {
        // generateSlug invents a random slug for a title with no letters or digits; a fixed
        // one keeps re-imports writing the same files.
        const base = /[a-z0-9]/i.test(script.title)
            ? truncateSlug(generateSlug(script.title), SLUG_BASE_LENGTH)
            : 'saved-script';
        let slug = base;
        for (let n = 2; used.has(slug); n += 1) {
            slug = `${base}-${n}`;
        }
        used.add(slug);
        return {
            version: 1,
            contentType: ContentAsCodeType.SQL_CHART,
            name: script.title.trim(),
            description: script.description?.trim() || null,
            slug,
            spaceSlug,
            sql: script.sql,
            limit: PORTAL_SCRIPT_CHART_LIMIT,
            chartKind: ChartKind.TABLE,
            config: {
                metadata: { version: 1 },
                type: ChartKind.TABLE,
                columns: {},
                display: {},
            },
        };
    });
};

type ImportPortalScriptsOptions = {
    path?: string;
    space: string;
    verbose: boolean;
};

export const importPortalScriptsHandler = async (
    file: string,
    options: ImportPortalScriptsOptions,
) => {
    GlobalState.setVerbose(options.verbose);
    const spaceSlug = options.space.trim();
    if (spaceSlug === '') {
        throw new ParseError('--space needs a space slug.');
    }

    let contents: string;
    try {
        contents = await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new ParseError(
            `Could not read the saved-scripts export ${file}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
    }
    let json: unknown;
    try {
        json = JSON.parse(contents);
    } catch {
        throw notAnExport(file, 'it is not valid JSON');
    }
    const charts = portalScriptsToSqlCharts(
        parsePortalSavedScripts(json, file),
        spaceSlug,
    );

    const chartsDir = path.join(getDownloadFolder(options.path), 'charts');
    await fs.mkdir(chartsDir, { recursive: true });
    for (const chart of charts) {
        const chartPath = path.join(chartsDir, `${chart.slug}.yml`);
        // eslint-disable-next-line no-await-in-loop
        await fs.writeFile(
            chartPath,
            yaml.dump(chart, { quotingType: '"', noRefs: true }),
        );
        GlobalState.debug(`Wrote ${chartPath}`);
    }

    console.info(
        styles.success(
            `Imported ${charts.length} saved script${
                charts.length === 1 ? '' : 's'
            } as SQL charts in ${chartsDir} (space "${spaceSlug}")`,
        ),
    );
    console.info(
        `Run ${styles.bold('lightdash upload')} to add them to your project.`,
    );
};
