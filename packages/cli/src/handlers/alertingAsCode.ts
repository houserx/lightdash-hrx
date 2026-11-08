// Alerting as code in the CLI (ENG-1799): `lightdash download --alerting-only`
// writes the project's Alert Rules, Contact Points and Notification Route
// tree as YAML, one document per file:
//
//   <path>/alert-rules/<slug>.yml
//   <path>/contact-points/<slug>.yml
//   <path>/notification-routes/notification-routes.yml
import {
    ParameterError,
    type AlertingAsCodeDocument,
    type AlertingAsCodeDownload,
} from '@lightdash/common';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import GlobalState from '../globalState';
import * as styles from '../styles';
import { getDownloadFolder } from './contentAsCodePaths';
import { lightdashApi } from './dbt/apiClient';

export const ALERT_RULES_FOLDER = 'alert-rules';
export const CONTACT_POINTS_FOLDER = 'contact-points';
export const NOTIFICATION_ROUTES_FOLDER = 'notification-routes';
export const NOTIFICATION_ROUTES_FILE = 'notification-routes.yml';

// Same pattern the as-code JSON schemas enforce; checked again here because
// the slug becomes a file name.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const assertFileSlug = (
    document: AlertingAsCodeDocument & { slug: string },
) => {
    if (!SLUG_PATTERN.test(document.slug)) {
        throw new ParameterError(
            `The server returned a ${document.type} document with an invalid slug "${document.slug}"`,
        );
    }
    return document.slug;
};

export const getAlertingAsCodeFilePath = (
    document: AlertingAsCodeDocument,
    basePath: string,
): string => {
    switch (document.type) {
        case 'alert_rule':
            return path.join(
                basePath,
                ALERT_RULES_FOLDER,
                `${assertFileSlug(document)}.yml`,
            );
        case 'contact_point':
            return path.join(
                basePath,
                CONTACT_POINTS_FOLDER,
                `${assertFileSlug(document)}.yml`,
            );
        case 'notification_routes':
            return path.join(
                basePath,
                NOTIFICATION_ROUTES_FOLDER,
                NOTIFICATION_ROUTES_FILE,
            );
        default: {
            const { type } = document as { type: unknown };
            throw new ParameterError(
                `The server returned an alerting document of unknown type "${String(type)}"`,
            );
        }
    }
};

export const dumpAlertingAsCodeYaml = (document: AlertingAsCodeDocument) =>
    // Keep the server's key order and never fold long queries.
    yaml.dump(document, { quotingType: '"', lineWidth: -1, noRefs: true });

export const downloadAlertingAsCode = async (
    projectUuid: string,
    customPath?: string,
): Promise<Record<AlertingAsCodeDocument['type'], number>> => {
    const { documents } = await lightdashApi<AlertingAsCodeDownload>({
        method: 'GET',
        url: `/api/v2/projects/${projectUuid}/alerting/as-code`,
        body: undefined,
    });
    const basePath = getDownloadFolder(customPath);
    // Resolve every path first so a bad document writes nothing.
    const files = documents.map((document) => ({
        document,
        filePath: getAlertingAsCodeFilePath(document, basePath),
    }));
    const counts: Record<AlertingAsCodeDocument['type'], number> = {
        alert_rule: 0,
        contact_point: 0,
        notification_routes: 0,
    };
    await Promise.all(
        files.map(async ({ document, filePath }) => {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, dumpAlertingAsCodeYaml(document));
            GlobalState.debug(`> Wrote ${document.type} to ${filePath}`);
        }),
    );
    files.forEach(({ document }) => {
        counts[document.type] += 1;
    });
    GlobalState.log(
        styles.success(
            `Downloaded ${counts.alert_rule} alert rules, ${counts.contact_point} contact points and ${counts.notification_routes} notification route trees to ${basePath}`,
        ),
    );
    return counts;
};
