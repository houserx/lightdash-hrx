// Alerting as code in the CLI (ENG-1799): `lightdash download --alerting-only`
// writes the project's Alert Rules, Contact Points and Notification Route
// tree as YAML, one document per file, and `lightdash upload --alerting-only`
// sends those files back:
//
//   <path>/alert-rules/<slug>.yml
//   <path>/contact-points/<slug>.yml
//   <path>/notification-routes/notification-routes.yml
import {
    ParameterError,
    type AlertingAsCodeDocument,
    type AlertingAsCodeDownload,
    type AlertingAsCodeType,
    type AlertingAsCodeUploadResult,
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

/**
 * Upload order: Contact Points first, then the route tree (it names Contact
 * Points), then Alert Rules.
 */
const UPLOAD_FOLDERS: { folder: string; type: AlertingAsCodeType }[] = [
    { folder: CONTACT_POINTS_FOLDER, type: 'contact_point' },
    { folder: NOTIFICATION_ROUTES_FOLDER, type: 'notification_routes' },
    { folder: ALERT_RULES_FOLDER, type: 'alert_rule' },
];

const isYamlFile = (name: string) => /\.ya?ml$/i.test(name);

const listYamlFiles = async (folder: string): Promise<string[]> => {
    try {
        const entries = await fs.readdir(folder, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && isYamlFile(entry.name))
            .map((entry) => entry.name)
            .sort()
            .map((name) => path.join(folder, name));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
};

export type AlertingAsCodeFile = {
    filePath: string;
    document: AlertingAsCodeDocument;
};

const readAlertingAsCodeFile = async (
    filePath: string,
    folder: string,
    type: AlertingAsCodeType,
): Promise<AlertingAsCodeFile> => {
    const content = await fs.readFile(filePath, 'utf8');
    let document: unknown;
    try {
        document = yaml.load(content);
    } catch (error) {
        throw new ParameterError(
            `${filePath}: invalid YAML: ${(error as Error).message}`,
        );
    }
    if (
        typeof document !== 'object' ||
        document === null ||
        Array.isArray(document)
    ) {
        throw new ParameterError(`${filePath}: expected one ${type} document`);
    }
    const documentType = (document as { type?: unknown }).type;
    if (documentType !== type) {
        throw new ParameterError(
            `${filePath}: files in ${folder}/ must be ${type} documents, found type "${String(documentType)}"`,
        );
    }
    return { filePath, document: document as AlertingAsCodeDocument };
};

/**
 * Reads every alerting document under `basePath`, in upload order: Contact
 * Points, the route tree, then Alert Rules (files by name within a folder).
 * Each file must hold one document of its folder's type. The server checks
 * the documents themselves against the JSON schemas.
 */
export const readAlertingAsCodeFiles = async (
    basePath: string,
): Promise<AlertingAsCodeFile[]> => {
    const perFolder = await Promise.all(
        UPLOAD_FOLDERS.map(async ({ folder, type }) => {
            const filePaths = await listYamlFiles(path.join(basePath, folder));
            return Promise.all(
                filePaths.map((filePath) =>
                    readAlertingAsCodeFile(filePath, folder, type),
                ),
            );
        }),
    );
    // Promise.all keeps input order, so this is the upload order.
    return perFolder.flat();
};

export const uploadAlertingAsCode = async (
    projectUuid: string,
    customPath?: string,
): Promise<AlertingAsCodeUploadResult | undefined> => {
    const basePath = getDownloadFolder(customPath);
    const files = await readAlertingAsCodeFiles(basePath);
    if (files.length === 0) {
        GlobalState.log(
            styles.warning(
                `No alerting documents found in ${basePath} (${ALERT_RULES_FOLDER}/, ${CONTACT_POINTS_FOLDER}/, ${NOTIFICATION_ROUTES_FOLDER}/); nothing uploaded`,
            ),
        );
        return undefined;
    }
    files.forEach(({ filePath, document }) => {
        GlobalState.debug(`> Uploading ${document.type} from ${filePath}`);
    });
    // One request: the server applies the documents in order in a single
    // transaction, so a failing document changes nothing.
    const result = await lightdashApi<AlertingAsCodeUploadResult>({
        method: 'POST',
        url: `/api/v2/projects/${projectUuid}/alerting/as-code`,
        body: JSON.stringify({
            documents: files.map(({ document }) => document),
        }),
    });
    const changes = { created: 0, updated: 0, unchanged: 0 };
    (result?.documents ?? []).forEach(({ change }) => {
        if (change in changes) changes[change] += 1;
    });
    const counts: Record<AlertingAsCodeType, number> = {
        alert_rule: 0,
        contact_point: 0,
        notification_routes: 0,
    };
    files.forEach(({ document }) => {
        counts[document.type] += 1;
    });
    GlobalState.log(
        styles.success(
            `Uploaded ${counts.contact_point} contact points, ${counts.notification_routes} notification route trees and ${counts.alert_rule} alert rules from ${basePath} (${changes.created} created, ${changes.updated} updated, ${changes.unchanged} unchanged)`,
        ),
    );
    return result;
};
