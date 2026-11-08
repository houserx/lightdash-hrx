import {
    ALERT_RULE_DEFAULTS,
    ALERTING_AS_CODE_TYPES,
    ALERTING_AS_CODE_VERSION,
    ConflictError,
    getNotificationRouteContactPoints,
    ParameterError,
    validateAlertingAsCode,
    type AlertingAsCodeDocument,
    type AlertingAsCodeDownload,
    type AlertingAsCodeType,
    type AlertingAsCodeUploadResult,
    type AlertRule,
    type AlertRuleAsCode,
    type AlertRuleDefinition,
    type ContactPointAsCode,
    type NotificationRoutesAsCode,
    type NotificationRouteTree,
    type SavedNotificationRouteTree,
    type SessionUser,
} from '@lightdash/common';
import { type Knex } from 'knex';
import {
    assertAlertingAbility,
    findProjectOrganizationUuid,
    isUniqueViolation,
    type AlertingSubject,
} from './alertingAccess';
import { getAlertRuleDefinition, type AlertRuleModel } from './AlertRuleModel';
import { validateAlertRuleDefinition } from './AlertRuleService';
import { type ContactPointModel } from './ContactPointModel';
import { type NotificationRouteModel } from './NotificationRouteModel';
import { parseNotificationRouteTree } from './NotificationRouteService';

const SUBJECT_BY_TYPE: Record<AlertingAsCodeType, AlertingSubject> = {
    alert_rule: 'AlertRule',
    contact_point: 'ContactPoint',
    notification_routes: 'NotificationRoute',
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isAsCodeType = (value: unknown): value is AlertingAsCodeType =>
    typeof value === 'string' &&
    (ALERTING_AS_CODE_TYPES as readonly string[]).includes(value);

/** `documents[2] (alert_rule rds-free-storage-low)`, for error messages. */
const documentLabel = (index: number, document: unknown): string => {
    if (!isPlainObject(document)) return `documents[${index}]`;
    const name = [document.type, document.slug]
        .filter((part): part is string => typeof part === 'string')
        .join(' ');
    return name ? `documents[${index}] (${name})` : `documents[${index}]`;
};

type ParsedUpload = {
    contactPoints: { index: number; document: ContactPointAsCode }[];
    tree: { index: number; tree: NotificationRouteTree } | undefined;
    rules: {
        index: number;
        slug: string;
        definition: AlertRuleDefinition;
    }[];
};

const invalidUpload = (errors: string[]): ParameterError =>
    new ParameterError(`Invalid alerting documents: ${errors.join('; ')}`, {
        errors,
    });

/**
 * A rule document as the rule it defines: the Alert Rule defaults for every
 * field it leaves out, and its folder resolved from `spaceSlug` (null when
 * it has none).
 */
const toRuleDefinition = (
    document: AlertRuleAsCode,
    spaceUuid: string | null,
): AlertRuleDefinition =>
    getAlertRuleDefinition({
        ...ALERT_RULE_DEFAULTS,
        labels: {},
        annotations: {},
        ...document,
        spaceUuid,
    });

const toRoutesDocument = ({
    managed: _managed,
    ...document
}: SavedNotificationRouteTree): NotificationRoutesAsCode => document;

/**
 * A rule as its document, every field spelled out. `spaceSlug` is left out
 * for a rule in no space.
 */
const toRuleDocument = (
    rule: AlertRule,
    spaceSlug: string | undefined,
): AlertRuleAsCode => ({
    version: ALERTING_AS_CODE_VERSION,
    type: 'alert_rule',
    slug: rule.slug,
    name: rule.name,
    description: rule.description,
    ...(spaceSlug === undefined ? {} : { spaceSlug }),
    labels: rule.labels,
    annotations: rule.annotations,
    query: rule.query,
    valueColumn: rule.valueColumn,
    reducer: rule.reducer,
    condition: rule.condition,
    for: rule.for,
    keepFiringFor: rule.keepFiringFor,
    interval: rule.interval,
    timeRange: rule.timeRange,
    noDataState: rule.noDataState,
    errorState: rule.errorState,
    paused: rule.paused,
    shadow: rule.shadow,
});

/**
 * Alerting as code: downloads and uploads of alert_rule, contact_point and
 * notification_routes documents. Every uploaded resource becomes managed.
 */
export class AlertingAsCodeService {
    constructor(
        private readonly deps: {
            database: Knex;
            alertRuleModel: AlertRuleModel;
            contactPointModel: ContactPointModel;
            notificationRouteModel: NotificationRouteModel;
            clock: { now(): Date };
        },
    ) {}

    private async assertAbility(
        user: SessionUser,
        action: 'view' | 'manage',
        subjectName: AlertingSubject,
        projectUuid: string,
    ) {
        await assertAlertingAbility(
            {
                findProjectOrganizationUuid: (uuid) =>
                    findProjectOrganizationUuid(this.deps.database, uuid),
            },
            user,
            action,
            subjectName,
            projectUuid,
        );
    }

    /**
     * Checks every document (schema, rule values, folder, tree timers, one
     * document per slug) and collects all problems into one 400.
     */
    private async parseDocuments(
        projectUuid: string,
        documents: unknown[],
    ): Promise<ParsedUpload> {
        const errors: string[] = [];
        const parsed: ParsedUpload = {
            contactPoints: [],
            tree: undefined,
            rules: [],
        };
        const valid: { index: number; document: unknown }[] = [];
        documents.forEach((document, index) => {
            const result = validateAlertingAsCode(document);
            if (result.valid) {
                valid.push({ index, document });
            } else {
                errors.push(
                    ...result.errors.map(
                        (error) =>
                            `${documentLabel(index, document)}: ${error}`,
                    ),
                );
            }
        });
        const seen = new Set<string>();
        const ruleDocuments = valid.filter(
            (entry): entry is { index: number; document: AlertRuleAsCode } =>
                (entry.document as AlertRuleAsCode).type === 'alert_rule',
        );
        const spaces =
            await this.deps.alertRuleModel.findProjectSpaceUuidsBySlug(
                projectUuid,
                [
                    ...new Set(
                        ruleDocuments
                            .map((e) => e.document.spaceSlug)
                            .filter(
                                (slug): slug is string => slug !== undefined,
                            ),
                    ),
                ],
            );
        valid.forEach(({ index, document }) => {
            const label = documentLabel(index, document);
            const typed = document as
                | AlertRuleAsCode
                | ContactPointAsCode
                | NotificationRoutesAsCode;
            const key =
                typed.type === 'notification_routes'
                    ? typed.type
                    : `${typed.type} ${typed.slug}`;
            if (seen.has(key)) {
                errors.push(
                    typed.type === 'notification_routes'
                        ? `${label}: only one notification_routes document may be uploaded`
                        : `${label}: slug "${typed.slug}" is uploaded more than once`,
                );
                return;
            }
            seen.add(key);
            try {
                if (typed.type === 'contact_point') {
                    parsed.contactPoints.push({ index, document: typed });
                } else if (typed.type === 'notification_routes') {
                    const { version: _v, type: _t, ...tree } = typed;
                    parsed.tree = {
                        index,
                        tree: parseNotificationRouteTree(tree),
                    };
                } else {
                    const spaceUuid =
                        typed.spaceSlug === undefined
                            ? null
                            : spaces.get(typed.spaceSlug);
                    if (spaceUuid === undefined) {
                        throw new ParameterError(
                            `spaceSlug: no space "${typed.spaceSlug}" in this project`,
                        );
                    }
                    const definition = toRuleDefinition(typed, spaceUuid);
                    validateAlertRuleDefinition(definition);
                    parsed.rules.push({
                        index,
                        slug: typed.slug,
                        definition,
                    });
                }
            } catch (error) {
                if (!(error instanceof ParameterError)) throw error;
                errors.push(`${label}: ${error.message}`);
            }
        });
        if (errors.length > 0) throw invalidUpload(errors);
        return parsed;
    }

    /**
     * Every Alert Rule and Contact Point of the project and its Notification
     * Route tree (when one is saved), as documents that upload back
     * unchanged. Needs view on all three; secrets are only `secretRef`s.
     */
    async download(
        user: SessionUser,
        projectUuid: string,
    ): Promise<AlertingAsCodeDownload> {
        for (const type of ALERTING_AS_CODE_TYPES) {
            // eslint-disable-next-line no-await-in-loop
            await this.assertAbility(
                user,
                'view',
                SUBJECT_BY_TYPE[type],
                projectUuid,
            );
        }
        const [contactPoints, tree, rules] = await Promise.all([
            this.deps.contactPointModel.list(projectUuid),
            this.deps.notificationRouteModel.find(projectUuid),
            this.deps.alertRuleModel.list(projectUuid),
        ]);
        const spaceSlugs =
            await this.deps.alertRuleModel.findProjectSpaceSlugsByUuid(
                projectUuid,
                [
                    ...new Set(
                        rules
                            .map((rule) => rule.spaceUuid)
                            .filter((uuid): uuid is string => uuid !== null),
                    ),
                ],
            );
        const documents: AlertingAsCodeDocument[] = [
            ...contactPoints.map(
                (contactPoint): ContactPointAsCode => ({
                    version: ALERTING_AS_CODE_VERSION,
                    type: 'contact_point',
                    slug: contactPoint.slug,
                    name: contactPoint.name,
                    integrations: contactPoint.integrations,
                }),
            ),
            ...(tree ? [toRoutesDocument(tree)] : []),
            ...rules.map((rule) =>
                toRuleDocument(
                    rule,
                    rule.spaceUuid === null
                        ? undefined
                        : spaceSlugs.get(rule.spaceUuid),
                ),
            ),
        ];
        return { documents };
    }

    /**
     * Upserts every document by slug, all or nothing: Contact Points, then
     * the Notification Route tree (which may name them), then Alert Rules.
     * Needs manage on each type uploaded; resources not in the upload are
     * left as they are.
     */
    async upload(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<AlertingAsCodeUploadResult> {
        const documents =
            isPlainObject(body) && Array.isArray(body.documents)
                ? body.documents
                : undefined;
        // Permissions first, so outsiders get a 403 whatever they send.
        const types = new Set(
            (documents ?? [])
                .map((document) =>
                    isPlainObject(document) ? document.type : undefined,
                )
                .filter(isAsCodeType),
        );
        if (types.size === 0) {
            await this.assertAbility(user, 'view', 'AlertRule', projectUuid);
        }
        for (const type of ALERTING_AS_CODE_TYPES) {
            if (types.has(type)) {
                // eslint-disable-next-line no-await-in-loop
                await this.assertAbility(
                    user,
                    'manage',
                    SUBJECT_BY_TYPE[type],
                    projectUuid,
                );
            }
        }
        if (documents === undefined) {
            throw new ParameterError(
                'The body must be {"documents": [ ...alerting documents ]}',
            );
        }
        const parsed = await this.parseDocuments(projectUuid, documents);
        try {
            const results = await this.deps.database.transaction((trx) =>
                this.write(trx, {
                    userUuid: user.userUuid,
                    projectUuid,
                    parsed,
                    labels: documents.map((d, i) => documentLabel(i, d)),
                }),
            );
            return { documents: results };
        } catch (error) {
            // A concurrent upload created one of the same slugs first.
            if (!isUniqueViolation(error)) throw error;
            throw new ConflictError(
                'Another change to these alerting resources happened at the same time; upload again',
            );
        }
    }

    private async write(
        trx: Knex.Transaction,
        args: {
            userUuid: string;
            projectUuid: string;
            parsed: ParsedUpload;
            labels: string[];
        },
    ): Promise<AlertingAsCodeUploadResult['documents']> {
        const { userUuid, projectUuid, parsed } = args;
        const now = this.deps.clock.now();
        const results: AlertingAsCodeUploadResult['documents'] = [];
        for (const { index, document } of parsed.contactPoints) {
            const { contactPointUuid, change } =
                // Sequential on purpose: one transaction, one connection.
                // eslint-disable-next-line no-await-in-loop
                await this.deps.contactPointModel.upsertManaged(trx, {
                    projectUuid,
                    slug: document.slug,
                    name: document.name,
                    integrations: document.integrations,
                    userUuid,
                    now,
                });
            results[index] = {
                type: 'contact_point',
                slug: document.slug,
                uuid: contactPointUuid,
                change,
            };
        }
        if (parsed.tree) {
            const { index, tree } = parsed.tree;
            const change = await this.deps.notificationRouteModel.saveManaged(
                trx,
                {
                    projectUuid,
                    tree,
                    userUuid,
                    now,
                    // Sees the Contact Points saved above.
                    check: (contactPointSlugs) => {
                        const unknown = [
                            ...new Set(getNotificationRouteContactPoints(tree)),
                        ].filter((slug) => !contactPointSlugs.has(slug));
                        if (unknown.length > 0) {
                            throw invalidUpload(
                                unknown.map(
                                    (slug) =>
                                        `${args.labels[index]}: contactPoint: no Contact Point "${slug}" in this project or this upload`,
                                ),
                            );
                        }
                    },
                },
            );
            results[index] = {
                type: 'notification_routes',
                slug: null,
                uuid: null,
                change,
            };
        }
        for (const { index, slug, definition } of parsed.rules) {
            const { ruleUuid, change } =
                // Sequential on purpose: one transaction, one connection.
                // eslint-disable-next-line no-await-in-loop
                await this.deps.alertRuleModel.upsertManaged(trx, {
                    projectUuid,
                    slug,
                    definition,
                    userUuid,
                    now,
                });
            results[index] = {
                type: 'alert_rule',
                slug,
                uuid: ruleUuid,
                change,
            };
        }
        return results;
    }
}
