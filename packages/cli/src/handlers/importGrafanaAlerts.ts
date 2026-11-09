import {
    convertGrafanaAlerting,
    GrafanaAlertingImportError,
    HclSyntaxError,
    ParseError,
    parseHcl,
    renderGrafanaAlertsImportReport,
    renderGrafanaRoutingFixes,
    type GrafanaRoutingDecisions,
    type TerraformSourceFile,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import GlobalState from '../globalState';
import * as styles from '../styles';
import {
    ALERT_RULES_FOLDER,
    CONTACT_POINTS_FOLDER,
    NOTIFICATION_ROUTES_FILE,
    NOTIFICATION_ROUTES_FOLDER,
} from './alertingAsCode';
import { readGrafanaDatasourcesFile } from './grafanaImportMaps';

type ImportGrafanaAlertsOptions = {
    rules: string[];
    contactPoints: string;
    policy: string;
    out: string;
    locals?: string[];
    datasources?: string;
    folders?: string;
    routingDecisions?: string;
    /** false with --no-routing-fixes. */
    routingFixes: boolean;
    verbose: boolean;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Reads one Terraform file and checks it parses; every failure names the file. */
const readTerraformFile = async (
    file: string,
    what: string,
): Promise<TerraformSourceFile> => {
    let text: string;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new ParseError(
            `Could not read the ${what} ${file}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
    }
    try {
        parseHcl(text, file);
    } catch (e) {
        if (e instanceof HclSyntaxError) {
            // The message starts with <file>:<line>:<column>.
            throw new ParseError(`Invalid Terraform in ${e.message}`);
        }
        throw e;
    }
    return { file, text };
};

/** One `severities:` or `teams:` mapping: value -> contact point slug or name. */
const readDecisionMap = (
    file: string,
    key: string,
    value: unknown,
): Record<string, string> | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ParseError(
            `${key}: in ${file} must be a mapping of ${key === 'severities' ? 'severity values' : 'teams'} to contact points.`,
        );
    }
    const map: Record<string, string> = {};
    Object.entries(value).forEach(([k, v]) => {
        if (typeof v !== 'string' || v.trim() === '') {
            throw new ParseError(
                `${key}: ${k} in ${file} must name a contact point (its slug or name).`,
            );
        }
        map[k] = v.trim();
    });
    return map;
};

/** `--routing-decisions <file.yml>`: a YAML mapping with severities: and teams: keys. */
const readRoutingDecisionsFile = async (
    file: string,
): Promise<GrafanaRoutingDecisions> => {
    let text: string;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new ParseError(
            `Could not read the routing decisions file ${file}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
    }
    let doc: unknown;
    try {
        doc = yaml.load(text);
    } catch (e) {
        throw new ParseError(
            `${file} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    if (
        doc !== undefined &&
        doc !== null &&
        (typeof doc !== 'object' || Array.isArray(doc))
    ) {
        throw new ParseError(
            `${file} must be a YAML mapping (severities: and teams: keys).`,
        );
    }
    const mapping = (doc ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(mapping).filter(
        (k) => k !== 'severities' && k !== 'teams',
    );
    if (unknownKeys.length > 0) {
        throw new ParseError(
            `${file} has unknown keys (${unknownKeys.join(', ')}); only severities: and teams: are read.`,
        );
    }
    const severities = readDecisionMap(file, 'severities', mapping.severities);
    const teams = readDecisionMap(file, 'teams', mapping.teams);
    return {
        ...(severities !== undefined ? { severities } : {}),
        ...(teams !== undefined ? { teams } : {}),
    };
};

// The JSON round trip drops `undefined` fields (js-yaml can't dump them).
const dumpYaml = (doc: unknown) =>
    yaml.dump(JSON.parse(JSON.stringify(doc)), {
        quotingType: '"',
        noRefs: true,
        lineWidth: -1,
    });

export const importGrafanaAlertsHandler = async (
    options: ImportGrafanaAlertsOptions,
) => {
    GlobalState.setVerbose(options.verbose);

    // Read and check every file before writing anything.
    const rules: TerraformSourceFile[] = [];
    for (const file of options.rules) {
        // eslint-disable-next-line no-await-in-loop
        rules.push(await readTerraformFile(file, 'rule group file'));
    }
    const contactPoints = await readTerraformFile(
        options.contactPoints,
        'contact points file',
    );
    const policy = await readTerraformFile(
        options.policy,
        'notification policy file',
    );
    const locals: TerraformSourceFile[] = [];
    for (const file of options.locals ?? []) {
        // eslint-disable-next-line no-await-in-loop
        locals.push(await readTerraformFile(file, 'locals file'));
    }
    const folders =
        options.folders === undefined
            ? undefined
            : await readTerraformFile(options.folders, 'folders file');
    const datasources =
        options.datasources === undefined
            ? undefined
            : await readGrafanaDatasourcesFile(options.datasources);
    const routingDecisions =
        options.routingDecisions === undefined
            ? undefined
            : await readRoutingDecisionsFile(options.routingDecisions);

    let result;
    try {
        result = convertGrafanaAlerting({
            rules,
            contactPoints,
            policy,
            locals,
            folders,
            datasources,
            routingFixes: options.routingFixes,
            routingDecisions,
        });
    } catch (e) {
        if (e instanceof GrafanaAlertingImportError) {
            throw new ParseError(e.message);
        }
        throw e;
    }

    const written: string[] = [];
    const write = async (rel: string, contents: string) => {
        const abs = path.join(options.out, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, contents);
        written.push(rel);
        GlobalState.debug(`Wrote ${abs}`);
    };
    for (const rule of result.alertRules) {
        // eslint-disable-next-line no-await-in-loop
        await write(`${ALERT_RULES_FOLDER}/${rule.slug}.yml`, dumpYaml(rule));
    }
    for (const contactPoint of result.contactPoints) {
        // eslint-disable-next-line no-await-in-loop
        await write(
            `${CONTACT_POINTS_FOLDER}/${contactPoint.slug}.yml`,
            dumpYaml(contactPoint),
        );
    }
    await write(
        `${NOTIFICATION_ROUTES_FOLDER}/${NOTIFICATION_ROUTES_FILE}`,
        dumpYaml(result.notificationRoutes),
    );
    await write(
        'ROUTING-FIXES.md',
        renderGrafanaRoutingFixes(result.routingFixes),
    );
    await write('IMPORT-REPORT.md', renderGrafanaAlertsImportReport(result));

    const byCode: Record<string, number> = {};
    result.warnings
        .map((w) => w.code)
        .sort()
        .forEach((code) => {
            byCode[code] = (byCode[code] ?? 0) + 1;
        });
    // A rule that needs review is the alerting counterpart of a dashboard TODO.
    const todos = result.warnings.filter(
        (w) => w.code === 'rule-needs-review',
    ).length;
    const summary = {
        command: 'grafana-alerts',
        warnings: { total: result.warnings.length, byCode },
        todos,
        files: [...written],
    };
    await write('import-summary.json', `${JSON.stringify(summary, null, 2)}\n`);

    console.info(
        styles.success(
            `Imported ${plural(result.alertRules.length, 'alert rule')}, ${plural(
                result.contactPoints.length,
                'contact point',
            )} and the notification routes into ${options.out} (${plural(
                result.warnings.length,
                'warning',
            )}, ${plural(todos, 'rule')} to review)`,
        ),
    );
    if (result.warnings.length > 0) {
        console.info(
            `See ${path.join(options.out, 'IMPORT-REPORT.md')} for every warning.`,
        );
    }
    const {
        unreachableRoutes,
        unhandledSeverities,
        unreachedContactPoints,
        applied,
    } = result.routingFixes;
    const decided = unhandledSeverities.filter(
        (u) => u.contactPoint !== undefined,
    ).length;
    const fixedOrFound = applied
        ? 'fixed'
        : 'found and not fixed (--no-routing-fixes)';
    const routingNotes = [
        ...(unreachableRoutes.length > 0
            ? [
                  `${plural(unreachableRoutes.length, 'unreachable route')} ${fixedOrFound}`,
              ]
            : []),
        ...(decided > 0
            ? [`${plural(decided, 'unhandled severity value')} ${fixedOrFound}`]
            : []),
        ...(unhandledSeverities.length > decided
            ? [
                  `${plural(
                      unhandledSeverities.length - decided,
                      'unhandled severity value',
                  )} needing a routing decision`,
              ]
            : []),
        ...(unreachedContactPoints.length > 0
            ? [
                  `${plural(
                      unreachedContactPoints.length,
                      'unreached contact point',
                  )} ${fixedOrFound}`,
              ]
            : []),
    ];
    if (routingNotes.length > 0) {
        console.info(
            `${routingNotes.join('; ')}; see ${path.join(
                options.out,
                'ROUTING-FIXES.md',
            )}.`,
        );
    }
    if (routingDecisions?.teams !== undefined) {
        console.warn(
            styles.warning(
                'Team routing decisions (teams: in --routing-decisions) are not implemented in this version of the importer and have no effect yet.',
            ),
        );
    }
    console.info(
        `Copy alert-rules/, contact-points/ and notification-routes/ into your project's lightdash/ folder, add the secrets the contact points reference, and run ${styles.bold(
            'lightdash upload --alerting-only',
        )}.`,
    );
};
