import {
    convertGrafanaAlerting,
    GrafanaAlertingImportError,
    HclSyntaxError,
    ParseError,
    parseHcl,
    renderGrafanaAlertsImportReport,
    renderGrafanaRoutingFixes,
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

/** `--routing-decisions <file.yml>`: checked to be a YAML mapping. */
const readRoutingDecisionsFile = async (file: string) => {
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
    if (options.routingDecisions !== undefined) {
        await readRoutingDecisionsFile(options.routingDecisions);
    }

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
    const routingDefects = result.routingFixes.unreachableRoutes.length;
    if (routingDefects > 0) {
        console.info(
            `${plural(routingDefects, 'unreachable route')} ${
                result.routingFixes.applied
                    ? 'fixed'
                    : 'found and not fixed (--no-routing-fixes)'
            }; see ${path.join(options.out, 'ROUTING-FIXES.md')}.`,
        );
    }
    if (options.routingDecisions !== undefined) {
        console.warn(
            styles.warning(
                'Routing decisions are not implemented in this version of the importer: --routing-decisions has no effect yet.',
            ),
        );
    }
    console.info(
        `Copy alert-rules/, contact-points/ and notification-routes/ into your project's lightdash/ folder, add the secrets the contact points reference, and run ${styles.bold(
            'lightdash upload --alerting-only',
        )}.`,
    );
};
