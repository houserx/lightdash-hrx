// `lightdash alerting shadow-report` (ENG-1799, ADR 0003): posts an exported
// Grafana state history and the expected routing differences to the project's
// Shadow Run report endpoint and prints the comparison.
import {
    LightdashError,
    ParameterError,
    type ShadowRunExpectedDifference,
    type ShadowRunFinding,
    type ShadowRunReport,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import { getConfig } from '../config';
import { refuseAgentConnection, resolveCredential } from '../credentials';
import GlobalState from '../globalState';
import * as styles from '../styles';
import { checkLightdashVersion, lightdashApi } from './dbt/apiClient';
import { selectProject } from './selectProject';

export type ShadowReportOptions = {
    project?: string;
    since: string;
    grafanaHistory: string;
    expectedDifferences?: string;
    json?: boolean;
    failOnUnexpected?: boolean;
    verbose?: boolean;
};

const readFileOrThrow = async (filePath: string, label: string) => {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        throw new ParameterError(
            `Could not read ${label} file ${filePath}: ${(error as Error).message}`,
        );
    }
};

export const readGrafanaHistoryFile = async (
    filePath: string,
): Promise<unknown> => {
    const text = await readFileOrThrow(filePath, '--grafana-history');
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new ParameterError(
            `${filePath} is not valid JSON: ${(error as Error).message}`,
        );
    }
};

/**
 * Reads the expected differences file: a YAML (or JSON) list of
 * `{ruleName, kind, reason}`. An empty file means no expected differences.
 * The server checks each entry.
 */
export const readExpectedDifferencesFile = async (
    filePath: string,
): Promise<ShadowRunExpectedDifference[]> => {
    const text = await readFileOrThrow(filePath, '--expected-differences');
    let parsed: unknown;
    try {
        parsed = yaml.load(text);
    } catch (error) {
        throw new ParameterError(
            `${filePath} is not valid YAML: ${(error as Error).message}`,
        );
    }
    if (parsed === undefined || parsed === null) return [];
    if (!Array.isArray(parsed)) {
        throw new ParameterError(
            `${filePath} must be a list of {ruleName, kind, reason}`,
        );
    }
    return parsed as ShadowRunExpectedDifference[];
};

const formatFinding = (finding: ShadowRunFinding) => {
    const marker = finding.expected
        ? styles.secondary('expected')
        : styles.error('UNEXPECTED');
    const reason = finding.reason ? ` (${finding.reason})` : '';
    return `  ${marker}  ${finding.ruleName} at ${finding.at}${reason}`;
};

export const formatShadowReport = (report: ShadowRunReport): string => {
    const lines: string[] = [];
    lines.push(styles.bold(`Matched (${report.matched.length})`));
    report.matched.forEach((match) => {
        lines.push(
            `  ${match.ruleName}: Grafana ${match.at}, Lightdash ${match.lightdashAt}`,
        );
    });
    lines.push(
        styles.bold(
            `Missing in Lightdash (${report.missingInLightdash.length})`,
        ),
    );
    report.missingInLightdash.forEach((finding) =>
        lines.push(formatFinding(finding)),
    );
    lines.push(
        styles.bold(`Extra in Lightdash (${report.extraInLightdash.length})`),
    );
    report.extraInLightdash.forEach((finding) =>
        lines.push(formatFinding(finding)),
    );
    lines.push(
        report.unexpectedCount > 0
            ? styles.error(`${report.unexpectedCount} unexpected differences`)
            : styles.success('No unexpected differences'),
    );
    return lines.join('\n');
};

export const alertingShadowReportHandler = async (
    options: ShadowReportOptions,
): Promise<void> => {
    refuseAgentConnection();
    GlobalState.setVerbose(options.verbose ?? false);
    if (!Number.isFinite(Date.parse(options.since))) {
        throw new ParameterError(
            `--since must be an ISO timestamp, got "${options.since}"`,
        );
    }
    // Read both files before any request so a bad file sends nothing.
    const grafanaHistory = await readGrafanaHistoryFile(options.grafanaHistory);
    const expectedDifferences = options.expectedDifferences
        ? await readExpectedDifferencesFile(options.expectedDifferences)
        : [];

    await checkLightdashVersion();
    const config = await getConfig();
    await resolveCredential(config);
    const project = await selectProject(config, options.project);
    if (!project) {
        throw new LightdashError({
            message: 'No project selected. Run lightdash config set-project',
            name: 'Not Found',
            statusCode: 404,
            data: {},
        });
    }
    GlobalState.debug(`> Shadow report for project ${project.projectUuid}`);

    const report = await lightdashApi<ShadowRunReport>({
        method: 'POST',
        url: `/api/v2/projects/${project.projectUuid}/alerting/shadow-report`,
        body: JSON.stringify({
            since: options.since,
            grafanaHistory,
            expectedDifferences,
        }),
    });

    // The report is the command's output: stdout. Everything else is stderr.
    if (options.json) {
        console.info(JSON.stringify(report, null, 2));
    } else {
        console.info(formatShadowReport(report));
    }

    if (options.failOnUnexpected && report.unexpectedCount > 0) {
        GlobalState.log(
            styles.error(
                `Failing: ${report.unexpectedCount} unexpected Shadow Run differences`,
            ),
        );
        process.exitCode = 1;
    }
};
