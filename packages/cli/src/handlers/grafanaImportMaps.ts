import {
    ParseError,
    parseGrafanaDashboardsTf,
    parseGrafanaDatasourcesTf,
    readGrafanaOpsMarts,
    type GrafanaDashboardsTfResource,
    type GrafanaDatasource,
    type GrafanaOpsMarts,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as styles from '../styles';

const readText = async (file: string, what: string): Promise<string> => {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new ParseError(
            `Could not read the ${what} ${file}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
    }
};

/**
 * `--datasources <grafana_data_sources.tf>`: the Grafana datasources, so each datasource uid
 * resolves to its Telemetry Source. A resource that can't be read is skipped with a warning.
 */
export const readGrafanaDatasourcesFile = async (
    file: string,
): Promise<GrafanaDatasource[]> => {
    const { datasources, skipped } = parseGrafanaDatasourcesTf(
        await readText(file, 'Grafana datasources file'),
    );
    skipped.forEach((line) =>
        console.warn(styles.warning(`${file}: skipped ${line}`)),
    );
    if (datasources.length === 0) {
        throw new ParseError(
            `${file} defines no grafana_data_source resource the importer can read. Pass the Terraform file with the resource "grafana_data_source" blocks (grafana_data_sources.tf).`,
        );
    }
    return datasources;
};

/**
 * `--dashboards-tf <grafana_dashboards.tf>`: which Grafana folder each folder of dashboard JSON
 * files goes to, so each dashboard lands in the space named after its folder. A resource that
 * can't be read is skipped with a warning.
 */
export const readGrafanaDashboardsTfFile = async (
    file: string,
): Promise<GrafanaDashboardsTfResource[]> => {
    const { dashboards, skipped } = parseGrafanaDashboardsTf(
        await readText(file, 'Grafana dashboards file'),
    );
    skipped.forEach((line) =>
        console.warn(styles.warning(`${file}: skipped ${line}`)),
    );
    if (dashboards.length === 0) {
        throw new ParseError(
            `${file} defines no grafana_dashboard resource the importer can read. Pass the Terraform file with the resource "grafana_dashboard" blocks (grafana_dashboards.tf).`,
        );
    }
    return dashboards;
};

/**
 * `--ops-marts <file.yml>`: the Ops Mart table for each GitHub and Sentry query type, e.g.
 * `github: {Pull_Requests: ops_marts.github.pull_requests}`.
 */
export const readGrafanaOpsMartsFile = async (
    file: string,
): Promise<GrafanaOpsMarts> => {
    const text = await readText(file, 'Ops Marts file');
    let doc: unknown;
    try {
        doc = yaml.load(text);
    } catch (e) {
        throw new ParseError(
            `${file} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    const result = readGrafanaOpsMarts(doc);
    if ('error' in result) {
        throw new ParseError(
            `${file} is not an Ops Marts map: ${result.error}`,
        );
    }
    return result.opsMarts;
};
