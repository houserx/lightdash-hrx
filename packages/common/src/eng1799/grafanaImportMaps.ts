/**
 * The maps the Grafana importers take from the command line: the datasources
 * `grafana_data_sources.tf` defines (`--datasources`) and the Ops Mart table for each GitHub and
 * Sentry query type (`--ops-marts`). Pure: the CLI reads the files and parses the YAML.
 */
import type { GrafanaDatasource, GrafanaQueryContext } from './grafanaQuery';

export type GrafanaOpsMarts = NonNullable<GrafanaQueryContext['opsMarts']>;

export type GrafanaDatasourcesTf = {
    datasources: GrafanaDatasource[];
    /** One line per `grafana_data_source` resource that could not be read, saying why. */
    skipped: string[];
};

/** A string value read from HCL: its text, or `undefined` when it is not a plain literal. */
type HclValue = { literal: string | undefined };

const isIdentifierChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch);

/**
 * Reads a double-quoted HCL string starting at `start` (the opening quote). Returns the index
 * after the closing quote and the text, or `undefined` text when the string interpolates
 * (`${...}` or `%{...}`), which only Terraform can evaluate.
 */
const readHclString = (
    text: string,
    start: number,
): { end: number; value: HclValue } => {
    let i = start + 1;
    let out = '';
    let literal = true;
    let depth = 0;
    while (i < text.length) {
        const ch = text[i];
        if (depth === 0 && ch === '"') {
            return {
                end: i + 1,
                value: { literal: literal ? out : undefined },
            };
        }
        if (ch === '\\' && i + 1 < text.length) {
            const next = text[i + 1];
            const escapes: Record<string, string> = {
                n: '\n',
                t: '\t',
                r: '\r',
                '"': '"',
                '\\': '\\',
            };
            out += escapes[next] ?? next;
            i += 2;
        } else if (
            (ch === '$' || ch === '%') &&
            text[i + 1] === '{' &&
            text[i - 1] !== ch
        ) {
            literal = false;
            depth += 1;
            i += 2;
        } else if ((ch === '$' || ch === '%') && text[i + 1] === ch) {
            // `$${` and `%%{` are escaped template markers.
            out += ch;
            i += 2;
        } else {
            if (depth > 0 && ch === '{') depth += 1;
            if (depth > 0 && ch === '}') depth -= 1;
            out += ch;
            i += 1;
        }
    }
    return { end: text.length, value: { literal: undefined } };
};

/** Skips a heredoc whose `<<` starts at `start`; returns the index after its closing marker. */
const skipHeredoc = (text: string, start: number): number => {
    const match = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[^\n]*\n/.exec(
        text.slice(start),
    );
    if (!match) return start + 2;
    const close = new RegExp(`^[ \\t]*${match[1]}[ \\t]*$`, 'm');
    const rest = text.slice(start + match[0].length);
    const found = close.exec(rest);
    return found
        ? start + match[0].length + found.index + found[0].length
        : text.length;
};

/** Skips whitespace and comments (`#`, `//`, `/* *\/`) from `start`. */
const skipTrivia = (text: string, start: number): number => {
    let i = start;
    while (i < text.length) {
        if (/\s/.test(text[i])) {
            i += 1;
        } else if (
            text[i] === '#' ||
            (text[i] === '/' && text[i + 1] === '/')
        ) {
            const nl = text.indexOf('\n', i);
            i = nl === -1 ? text.length : nl + 1;
        } else if (text[i] === '/' && text[i + 1] === '*') {
            const endComment = text.indexOf('*/', i + 2);
            i = endComment === -1 ? text.length : endComment + 2;
        } else {
            return i;
        }
    }
    return i;
};

/** Drops a trailing `#` or `//` comment from one line of HCL, leaving quoted text alone. */
const stripLineComment = (line: string): string => {
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inString && ch === '\\') {
            i += 1;
        } else if (ch === '"') {
            inString = !inString;
        } else if (
            !inString &&
            (ch === '#' || (ch === '/' && line[i + 1] === '/'))
        ) {
            return line.slice(0, i);
        }
    }
    return line;
};

type HclBlock = {
    labels: string[];
    type: string;
    /** The block's top-level `name = value` attributes. */
    attributes: Map<string, HclValue>;
    /**
     * The source text of each top-level attribute's value, from after `=` to the end of its
     * line (comments dropped), for the expressions a plain literal can't hold.
     */
    expressions: Map<string, string>;
};

/**
 * Reads the top-level blocks of an HCL file and each block's top-level attributes. Values are
 * kept only when they are plain string literals; expressions, nested blocks, lists and maps are
 * skipped. That is all `grafana_data_sources.tf` needs; evaluating Terraform is not attempted.
 */
const readHclBlocks = (text: string): HclBlock[] => {
    const blocks: HclBlock[] = [];
    let current: HclBlock | undefined;
    let depth = 0;
    let pendingWords: string[] = [];
    let attributeName: string | undefined;
    let i = 0;
    while (i < text.length) {
        i = skipTrivia(text, i);
        if (i >= text.length) break;
        const ch = text[i];
        if (ch === '"') {
            const { end, value } = readHclString(text, i);
            if (depth === 1 && current && attributeName !== undefined) {
                // A plain literal only when nothing else follows on the attribute's line.
                const lineEnd = text.indexOf('\n', end);
                const tail = text.slice(
                    end,
                    lineEnd === -1 ? text.length : lineEnd,
                );
                const plain = /^\s*(#.*|\/\/.*)?$/.test(tail);
                current.attributes.set(attributeName, {
                    literal: plain ? value.literal : undefined,
                });
                attributeName = undefined;
            } else if (depth === 0 && value.literal !== undefined) {
                pendingWords.push(value.literal);
            }
            i = end;
        } else if (ch === '<' && text[i + 1] === '<') {
            if (depth === 1 && current && attributeName !== undefined) {
                current.attributes.set(attributeName, { literal: undefined });
                attributeName = undefined;
            }
            i = skipHeredoc(text, i);
        } else if (ch === '{') {
            if (depth === 0) {
                const [type, ...labels] = pendingWords;
                current =
                    type === undefined
                        ? undefined
                        : {
                              type,
                              labels,
                              attributes: new Map(),
                              expressions: new Map(),
                          };
                if (current) blocks.push(current);
                pendingWords = [];
            } else if (depth === 1 && current && attributeName !== undefined) {
                current.attributes.set(attributeName, { literal: undefined });
                attributeName = undefined;
            }
            depth += 1;
            i += 1;
        } else if (ch === '}') {
            depth = Math.max(0, depth - 1);
            if (depth === 0) current = undefined;
            attributeName = undefined;
            i += 1;
        } else if (ch === '[' || ch === '(') {
            if (depth === 1 && current && attributeName !== undefined) {
                current.attributes.set(attributeName, { literal: undefined });
                attributeName = undefined;
            }
            // Brackets don't change block depth; their contents are read as trivia and words.
            i += 1;
        } else if (isIdentifierChar(ch)) {
            let end = i;
            while (end < text.length && /[A-Za-z0-9_.-]/.test(text[end])) {
                end += 1;
            }
            const word = text.slice(i, end);
            const after = skipTrivia(text, end);
            if (depth === 1 && text[after] === '=' && text[after + 1] !== '=') {
                attributeName = word;
                i = after + 1;
                if (current) {
                    const lineEnd = text.indexOf('\n', i);
                    current.expressions.set(
                        word,
                        stripLineComment(
                            text.slice(
                                i,
                                lineEnd === -1 ? text.length : lineEnd,
                            ),
                        ).trim(),
                    );
                }
            } else {
                if (depth === 1 && current && attributeName !== undefined) {
                    // `name = local.x`, `name = var.y`, numbers, booleans: not a string literal.
                    current.attributes.set(attributeName, {
                        literal: undefined,
                    });
                    attributeName = undefined;
                }
                if (depth === 0) pendingWords.push(word);
                i = end;
            }
        } else {
            i += 1;
        }
    }
    return blocks;
};

/**
 * The datasources `grafana_data_sources.tf` defines: each `resource "grafana_data_source"`
 * block's `type`, `name` and `uid`. A resource whose `type` or `name` is not a plain string is
 * skipped and listed in `skipped`. A resource without a `uid` (Grafana generates one) is kept
 * with an empty uid, so dashboards that name it still resolve.
 */
export const parseGrafanaDatasourcesTf = (
    text: string,
): GrafanaDatasourcesTf => {
    const datasources: GrafanaDatasource[] = [];
    const skipped: string[] = [];
    readHclBlocks(text)
        .filter(
            (block) =>
                block.type === 'resource' &&
                block.labels[0] === 'grafana_data_source',
        )
        .forEach((block) => {
            const label = `grafana_data_source.${block.labels[1] ?? '(unnamed)'}`;
            const read = (key: string) => {
                const value = block.attributes.get(key);
                if (value === undefined) return { missing: true as const };
                return { missing: false as const, literal: value.literal };
            };
            const type = read('type');
            const name = read('name');
            const uid = read('uid');
            const problems = [
                ...(['type', 'name'] as const).flatMap((key) => {
                    const v = key === 'type' ? type : name;
                    if (v.missing) return [`has no ${key}`];
                    return v.literal === undefined
                        ? [`has a ${key} Terraform computes`]
                        : [];
                }),
                ...(!uid.missing && uid.literal === undefined
                    ? ['has a uid Terraform computes']
                    : []),
            ];
            if (
                problems.length > 0 ||
                type.literal === undefined ||
                name.literal === undefined
            ) {
                skipped.push(`${label} ${problems.join(' and ')}`);
                return;
            }
            datasources.push({
                type: type.literal,
                name: name.literal,
                uid: uid.missing ? '' : (uid.literal ?? ''),
            });
        });
    return { datasources, skipped };
};

/** One `resource "grafana_dashboard"` block: the dashboards a folder of JSON files holds. */
export type GrafanaDashboardsTfResource = {
    /** `grafana_dashboard.<name>`. */
    resource: string;
    /** The fileset directory without `${path.module}/`, e.g. `grafana_config/rds`. */
    dir: string;
    /** The fileset pattern, e.g. `*.json`. */
    pattern: string;
    /** The Grafana folder title, or `undefined` for a dashboard Grafana keeps at the root. */
    folder: string | undefined;
};

export type GrafanaDashboardsTf = {
    dashboards: GrafanaDashboardsTfResource[];
    /** One line per `grafana_dashboard` resource that could not be read, saying why. */
    skipped: string[];
};

const FILESET_RE = /^fileset\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)$/;
const FOLDER_RE = /^grafana_folder\.[A-Za-z0-9_-]+\["([^"]+)"\]\.u?id$/;

/**
 * The dashboards `grafana_dashboards.tf` places in folders: each `resource "grafana_dashboard"`
 * with `for_each = fileset("${path.module}/<dir>", "<pattern>")` and
 * `folder = grafana_folder.<name>["<title>"].id` (or no `folder`, for the root). A resource in
 * another shape (a single `config_json`, a computed folder) is listed in `skipped`.
 */
export const parseGrafanaDashboardsTf = (text: string): GrafanaDashboardsTf => {
    const dashboards: GrafanaDashboardsTfResource[] = [];
    const skipped: string[] = [];
    readHclBlocks(text)
        .filter(
            (block) =>
                block.type === 'resource' &&
                block.labels[0] === 'grafana_dashboard',
        )
        .forEach((block) => {
            const resource = `grafana_dashboard.${block.labels[1] ?? '(unnamed)'}`;
            const forEach = block.expressions.get('for_each');
            const fileset =
                forEach === undefined ? null : FILESET_RE.exec(forEach);
            if (!fileset) {
                skipped.push(
                    `${resource}: it has no for_each = fileset("<dir>", "<pattern>")`,
                );
                return;
            }
            const folderText = block.expressions.get('folder');
            let folder: string | undefined;
            if (folderText !== undefined) {
                const match = FOLDER_RE.exec(folderText);
                if (!match || !/[A-Za-z0-9]/.test(match[1])) {
                    skipped.push(
                        `${resource}: its folder ${folderText} is not grafana_folder.<name>["<title>"].id`,
                    );
                    return;
                }
                [, folder] = match;
            }
            const dir = fileset[1]
                .replace(/^\$\{path\.(module|root|cwd)\}\/?/, '')
                .replace(/\/+$/, '');
            dashboards.push({ resource, dir, pattern: fileset[2], folder });
        });
    return { dashboards, skipped };
};

/** A Terraform fileset pattern (`*`, `?`, `{a,b}`) as a regex over one file name. */
const filesetPatternRegex = (pattern: string): RegExp => {
    let re = '';
    let braces = 0;
    for (const ch of pattern) {
        if (ch === '*') re += '[^/]*';
        else if (ch === '?') re += '[^/]';
        else if (ch === '{') {
            braces += 1;
            re += '(?:';
        } else if (ch === '}' && braces > 0) {
            braces -= 1;
            re += ')';
        } else if (ch === ',' && braces > 0) re += '|';
        else re += ch.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
    }
    re += ')'.repeat(braces);
    return new RegExp(`^${re}$`);
};

/**
 * The `grafana_dashboard` resource a dashboard file belongs to: the one whose fileset directory
 * ends the file's directory (path segments compared, so `grafana_config/rds` matches
 * `/any/where/grafana_config/rds/pg_cron.json`) and whose pattern matches its name. The longest
 * directory wins. `undefined` when no resource holds the file.
 */
export const findGrafanaDashboardResource = (
    resources: GrafanaDashboardsTfResource[],
    file: string,
): GrafanaDashboardsTfResource | undefined => {
    const segments = file.split(/[\\/]+/).filter((s) => s !== '');
    const name = segments.pop() ?? '';
    return resources
        .filter((r) => {
            const dirSegments = r.dir.split('/').filter((s) => s !== '');
            if (dirSegments.length > segments.length) return false;
            const tail = segments.slice(segments.length - dirSegments.length);
            return (
                dirSegments.every((s, i) => s === tail[i]) &&
                filesetPatternRegex(r.pattern).test(name)
            );
        })
        .sort((a, b) => b.dir.length - a.dir.length)[0];
};

const OPS_MART_KEYS = ['github', 'sentry'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a parsed `--ops-marts` document: `github` and `sentry` each map a Grafana query type
 * (`Pull_Requests`, `issues`, ...) to an `ops_marts.<dataset>.<table>` table name. Returns the
 * map, or an error naming the first problem.
 */
export const readGrafanaOpsMarts = (
    doc: unknown,
): { opsMarts: GrafanaOpsMarts } | { error: string } => {
    if (doc === null || doc === undefined) return { opsMarts: {} };
    if (!isRecord(doc)) {
        return {
            error: 'it must be a map with github and/or sentry keys, each mapping a query type to an ops_marts.<dataset>.<table> table',
        };
    }
    const opsMarts: GrafanaOpsMarts = {};
    for (const [key, value] of Object.entries(doc)) {
        if (!(OPS_MART_KEYS as readonly string[]).includes(key)) {
            return {
                error: `unknown key ${key}; only ${OPS_MART_KEYS.join(' and ')} are read`,
            };
        }
        if (value === null || value === undefined) {
            // An empty section maps nothing.
        } else if (!isRecord(value)) {
            return {
                error: `${key} must map each query type to an ops_marts.<dataset>.<table> table`,
            };
        } else {
            const tables: Record<string, string> = {};
            for (const [queryType, table] of Object.entries(value)) {
                // The table name itself is checked where it is used (`ops-mart-invalid`).
                if (typeof table !== 'string' || table.trim() === '') {
                    return {
                        error: `${key}.${queryType} must be an ops_marts.<dataset>.<table> table name, not ${JSON.stringify(table)}`,
                    };
                }
                tables[queryType] = table.trim();
            }
            opsMarts[key as (typeof OPS_MART_KEYS)[number]] = tables;
        }
    }
    return { opsMarts };
};
