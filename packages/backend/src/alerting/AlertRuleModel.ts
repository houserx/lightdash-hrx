import {
    type AlertCondition,
    type AlertErrorState,
    type AlertingAsCodeChange,
    type AlertInstanceState,
    type AlertNoDataState,
    type AlertReducer,
    type AlertRule,
    type AlertRuleDefinition,
    type AlertRuleInstance,
    type AlertRuleVersion,
} from '@lightdash/common';
import { type Knex } from 'knex';
import { ProjectTableName } from '../database/entities/projects';
import { SpaceTableName } from '../database/entities/spaces';
import {
    findProjectOrganizationUuid,
    slugPrefixPattern,
    stableStringify,
} from './alertingAccess';

// Tables from migration 20261108120000_create_alerting_tables.
export const AlertRulesTableName = 'alert_rules';
export const AlertRuleVersionsTableName = 'alert_rule_versions';
export const AlertInstancesTableName = 'alert_instances';

type DbAlertRule = {
    alert_rule_uuid: string;
    project_uuid: string;
    space_uuid: string | null;
    slug: string;
    name: string;
    description: string;
    query: string;
    value_column: string;
    reducer: AlertReducer;
    condition: AlertCondition;
    for_duration: string;
    keep_firing_for: string;
    interval: string;
    time_range: string;
    no_data_state: AlertNoDataState;
    error_state: AlertErrorState;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    paused: boolean;
    shadow: boolean;
    managed: boolean;
    created_by_user_uuid: string | null;
    updated_by_user_uuid: string | null;
    created_at: Date;
    updated_at: Date;
};

type DbAlertRuleWithVersion = DbAlertRule & { version: number };

type DbAlertRuleVersion = {
    version: number;
    definition: AlertRuleDefinition;
    created_by_user_uuid: string | null;
    created_at: Date;
};

type DbAlertInstance = {
    alert_rule_uuid: string;
    fingerprint: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    state: AlertInstanceState;
    value: number | null;
    state_since: Date;
    active_at: Date | null;
    last_evaluated_at: Date | null;
};

const toDbDefinition = (
    definition: AlertRuleDefinition,
): Omit<
    DbAlertRule,
    | 'alert_rule_uuid'
    | 'project_uuid'
    | 'slug'
    | 'managed'
    | 'created_by_user_uuid'
    | 'updated_by_user_uuid'
    | 'created_at'
    | 'updated_at'
> => ({
    space_uuid: definition.spaceUuid,
    name: definition.name,
    description: definition.description,
    query: definition.query,
    value_column: definition.valueColumn,
    reducer: definition.reducer,
    condition: definition.condition,
    for_duration: definition.for,
    keep_firing_for: definition.keepFiringFor,
    interval: definition.interval,
    time_range: definition.timeRange,
    no_data_state: definition.noDataState,
    error_state: definition.errorState,
    labels: definition.labels,
    annotations: definition.annotations,
    paused: definition.paused,
    shadow: definition.shadow,
});

const toAlertRule = (row: DbAlertRuleWithVersion): AlertRule => ({
    uuid: row.alert_rule_uuid,
    projectUuid: row.project_uuid,
    spaceUuid: row.space_uuid,
    slug: row.slug,
    name: row.name,
    description: row.description,
    labels: row.labels,
    annotations: row.annotations,
    query: row.query,
    valueColumn: row.value_column,
    reducer: row.reducer,
    condition: row.condition,
    for: row.for_duration,
    keepFiringFor: row.keep_firing_for,
    interval: row.interval,
    timeRange: row.time_range,
    noDataState: row.no_data_state,
    errorState: row.error_state,
    paused: row.paused,
    shadow: row.shadow,
    managed: row.managed,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdByUserUuid: row.created_by_user_uuid,
    updatedByUserUuid: row.updated_by_user_uuid,
});

/** The editable fields of a rule, as stored in a version snapshot. */
export const getAlertRuleDefinition = (
    rule: AlertRuleDefinition,
): AlertRuleDefinition => ({
    name: rule.name,
    description: rule.description,
    spaceUuid: rule.spaceUuid,
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

export class AlertRuleModel {
    constructor(private readonly database: Knex) {}

    private selectRules(trx: Knex = this.database) {
        return trx(AlertRulesTableName).select<DbAlertRuleWithVersion[]>(
            `${AlertRulesTableName}.*`,
            trx.raw(
                `COALESCE((SELECT MAX(v.version) FROM ${AlertRuleVersionsTableName} v WHERE v.alert_rule_uuid = ${AlertRulesTableName}.alert_rule_uuid), 0) AS version`,
            ),
        );
    }

    /** Organization of a project, or undefined when it doesn't exist. */
    async findProjectOrganizationUuid(
        projectUuid: string,
    ): Promise<string | undefined> {
        return findProjectOrganizationUuid(this.database, projectUuid);
    }

    /** Whether the space exists in the project and isn't in the trash. */
    async isProjectSpace(
        projectUuid: string,
        spaceUuid: string,
    ): Promise<boolean> {
        const row = await this.database(SpaceTableName)
            .innerJoin(
                ProjectTableName,
                `${ProjectTableName}.project_id`,
                `${SpaceTableName}.project_id`,
            )
            .where(`${ProjectTableName}.project_uuid`, projectUuid)
            .andWhere(`${SpaceTableName}.space_uuid`, spaceUuid)
            .whereNull(`${SpaceTableName}.deleted_at`)
            .first<{ space_uuid: string } | undefined>(
                `${SpaceTableName}.space_uuid`,
            );
        return row !== undefined;
    }

    /**
     * Uuids of the project's spaces (not in the trash) with these slugs,
     * keyed by slug; unknown slugs are left out.
     */
    async findProjectSpaceUuidsBySlug(
        projectUuid: string,
        slugs: string[],
    ): Promise<Map<string, string>> {
        if (slugs.length === 0) return new Map();
        const rows = await this.database(SpaceTableName)
            .innerJoin(
                ProjectTableName,
                `${ProjectTableName}.project_id`,
                `${SpaceTableName}.project_id`,
            )
            .where(`${ProjectTableName}.project_uuid`, projectUuid)
            .whereIn(`${SpaceTableName}.slug`, slugs)
            .whereNull(`${SpaceTableName}.deleted_at`)
            .select<{ slug: string; space_uuid: string }[]>(
                `${SpaceTableName}.slug`,
                `${SpaceTableName}.space_uuid`,
            );
        return new Map(rows.map((row) => [row.slug, row.space_uuid]));
    }

    /**
     * Slugs of the project's spaces with these uuids, keyed by uuid; unknown
     * uuids are left out.
     */
    async findProjectSpaceSlugsByUuid(
        projectUuid: string,
        spaceUuids: string[],
    ): Promise<Map<string, string>> {
        if (spaceUuids.length === 0) return new Map();
        const rows = await this.database(SpaceTableName)
            .innerJoin(
                ProjectTableName,
                `${ProjectTableName}.project_id`,
                `${SpaceTableName}.project_id`,
            )
            .where(`${ProjectTableName}.project_uuid`, projectUuid)
            .whereIn(`${SpaceTableName}.space_uuid`, spaceUuids)
            .select<{ slug: string; space_uuid: string }[]>(
                `${SpaceTableName}.slug`,
                `${SpaceTableName}.space_uuid`,
            );
        return new Map(rows.map((row) => [row.space_uuid, row.slug]));
    }

    async find(
        projectUuid: string,
        ruleUuid: string,
    ): Promise<AlertRule | undefined> {
        const row = await this.selectRules()
            .where(`${AlertRulesTableName}.project_uuid`, projectUuid)
            .andWhere(`${AlertRulesTableName}.alert_rule_uuid`, ruleUuid)
            .first();
        return row ? toAlertRule(row) : undefined;
    }

    /** A rule by uuid in any project (the evaluator has no request scope). */
    async findByUuid(ruleUuid: string): Promise<AlertRule | undefined> {
        const row = await this.selectRules()
            .where(`${AlertRulesTableName}.alert_rule_uuid`, ruleUuid)
            .first();
        return row ? toAlertRule(row) : undefined;
    }

    async list(projectUuid: string): Promise<AlertRule[]> {
        const rows = await this.selectRules()
            .where(`${AlertRulesTableName}.project_uuid`, projectUuid)
            .orderBy([
                { column: `${AlertRulesTableName}.name`, order: 'asc' },
                { column: `${AlertRulesTableName}.created_at`, order: 'asc' },
            ]);
        return rows.map(toAlertRule);
    }

    async getSlugs(projectUuid: string, prefix: string): Promise<string[]> {
        const rows = await this.database(AlertRulesTableName)
            .where('project_uuid', projectUuid)
            .andWhere('slug', 'like', slugPrefixPattern(prefix))
            .select<{ slug: string }[]>('slug');
        return rows.map((row) => row.slug);
    }

    async create(args: {
        projectUuid: string;
        slug: string;
        definition: AlertRuleDefinition;
        userUuid: string;
        now: Date;
    }): Promise<string> {
        return this.database.transaction((trx) =>
            this.insertRule(trx, { ...args, managed: false }),
        );
    }

    /** Inserts the rule and its version 1. */
    private async insertRule(
        trx: Knex,
        args: {
            projectUuid: string;
            slug: string;
            definition: AlertRuleDefinition;
            managed: boolean;
            userUuid: string;
            now: Date;
        },
    ): Promise<string> {
        const [{ alert_rule_uuid: ruleUuid }] = await trx(AlertRulesTableName)
            .insert({
                ...toDbDefinition(args.definition),
                // jsonb columns: knex would send objects as-is otherwise.
                condition: JSON.stringify(args.definition.condition),
                labels: JSON.stringify(args.definition.labels),
                annotations: JSON.stringify(args.definition.annotations),
                project_uuid: args.projectUuid,
                slug: args.slug,
                managed: args.managed,
                created_by_user_uuid: args.userUuid,
                updated_by_user_uuid: args.userUuid,
                created_at: args.now,
                updated_at: args.now,
            })
            .returning<{ alert_rule_uuid: string }[]>('alert_rule_uuid');
        await trx(AlertRuleVersionsTableName).insert({
            alert_rule_uuid: ruleUuid,
            version: 1,
            definition: JSON.stringify(args.definition),
            created_by_user_uuid: args.userUuid,
            created_at: args.now,
        });
        return ruleUuid;
    }

    /** Saves `next` over the rule's definition as version `version`. */
    private async writeVersion(
        trx: Knex,
        args: {
            ruleUuid: string;
            version: number;
            next: AlertRuleDefinition;
            userUuid: string;
            now: Date;
        },
    ): Promise<void> {
        await trx(AlertRulesTableName)
            .where('alert_rule_uuid', args.ruleUuid)
            .update({
                ...toDbDefinition(args.next),
                condition: JSON.stringify(args.next.condition),
                labels: JSON.stringify(args.next.labels),
                annotations: JSON.stringify(args.next.annotations),
                updated_by_user_uuid: args.userUuid,
                updated_at: args.now,
            });
        await trx(AlertRuleVersionsTableName).insert({
            alert_rule_uuid: args.ruleUuid,
            version: args.version,
            definition: JSON.stringify(args.next),
            created_by_user_uuid: args.userUuid,
            created_at: args.now,
        });
    }

    /**
     * As-code upload, inside the caller's transaction: creates the rule with
     * this slug, or saves `definition` over it as the next version (only if
     * the definition changed), and marks it managed either way.
     */
    async upsertManaged(
        trx: Knex.Transaction,
        args: {
            projectUuid: string;
            slug: string;
            definition: AlertRuleDefinition;
            userUuid: string;
            now: Date;
        },
    ): Promise<{ ruleUuid: string; change: AlertingAsCodeChange }> {
        const row = await this.selectRules(trx)
            .where(`${AlertRulesTableName}.project_uuid`, args.projectUuid)
            .andWhere(`${AlertRulesTableName}.slug`, args.slug)
            .forUpdate()
            .first();
        if (!row) {
            const ruleUuid = await this.insertRule(trx, {
                ...args,
                managed: true,
            });
            return { ruleUuid, change: 'created' };
        }
        const current = toAlertRule(row);
        const definitionChanged =
            stableStringify(args.definition) !==
            stableStringify(getAlertRuleDefinition(current));
        if (definitionChanged) {
            await this.writeVersion(trx, {
                ruleUuid: current.uuid,
                version: current.version + 1,
                next: args.definition,
                userUuid: args.userUuid,
                now: args.now,
            });
        }
        if (!current.managed) {
            await trx(AlertRulesTableName)
                .where('alert_rule_uuid', current.uuid)
                .update({
                    managed: true,
                    updated_by_user_uuid: args.userUuid,
                    updated_at: args.now,
                });
        }
        return {
            ruleUuid: current.uuid,
            change:
                definitionChanged || !current.managed ? 'updated' : 'unchanged',
        };
    }

    /**
     * Applies `change` to the rule's current definition and saves it as the
     * next version. Returns undefined when the rule is gone, and `changed:
     * false` (no new version) when the change leaves the definition as is.
     */
    async update(args: {
        projectUuid: string;
        ruleUuid: string;
        apply: (current: AlertRule) => AlertRuleDefinition;
        userUuid: string;
        now: Date;
    }): Promise<{ changed: boolean } | undefined> {
        return this.database.transaction(async (trx) => {
            const row = await this.selectRules(trx)
                .where(`${AlertRulesTableName}.project_uuid`, args.projectUuid)
                .andWhere(
                    `${AlertRulesTableName}.alert_rule_uuid`,
                    args.ruleUuid,
                )
                .forUpdate()
                .first();
            if (!row) return undefined;
            const current = toAlertRule(row);
            const next = args.apply(current);
            if (
                stableStringify(next) ===
                stableStringify(getAlertRuleDefinition(current))
            ) {
                return { changed: false };
            }
            await this.writeVersion(trx, {
                ruleUuid: args.ruleUuid,
                version: current.version + 1,
                next,
                userUuid: args.userUuid,
                now: args.now,
            });
            return { changed: true };
        });
    }

    /** Every saved version of the rule, newest first. */
    async listVersions(ruleUuid: string): Promise<AlertRuleVersion[]> {
        const rows = await this.database(AlertRuleVersionsTableName)
            .where('alert_rule_uuid', ruleUuid)
            .orderBy('version', 'desc')
            .select<DbAlertRuleVersion[]>(
                'version',
                'definition',
                'created_by_user_uuid',
                'created_at',
            );
        return rows.map((row) => ({
            version: Number(row.version),
            rule: getAlertRuleDefinition(row.definition),
            createdByUserUuid: row.created_by_user_uuid,
            createdAt: row.created_at.toISOString(),
        }));
    }

    /** Deletes the rule; its versions, series and history cascade. */
    async delete(projectUuid: string, ruleUuid: string): Promise<boolean> {
        const deleted = await this.database(AlertRulesTableName)
            .where({ project_uuid: projectUuid, alert_rule_uuid: ruleUuid })
            .delete();
        return deleted > 0;
    }

    /** Current series of the given rules, keyed by rule uuid. */
    async getInstances(
        ruleUuids: string[],
    ): Promise<Map<string, AlertRuleInstance[]>> {
        const byRule = new Map<string, AlertRuleInstance[]>();
        if (ruleUuids.length === 0) return byRule;
        const rows = await this.database(AlertInstancesTableName)
            .whereIn('alert_rule_uuid', ruleUuids)
            .orderBy('fingerprint')
            .select<DbAlertInstance[]>(
                'alert_rule_uuid',
                'fingerprint',
                'labels',
                'annotations',
                'state',
                'value',
                'state_since',
                'active_at',
                'last_evaluated_at',
            );
        rows.forEach((row) => {
            const instances = byRule.get(row.alert_rule_uuid) ?? [];
            instances.push({
                fingerprint: row.fingerprint,
                labels: row.labels,
                annotations: row.annotations,
                state: row.state,
                value: row.value === null ? null : Number(row.value),
                since: row.state_since.toISOString(),
                activeAt: row.active_at?.toISOString() ?? null,
                lastEvaluatedAt: row.last_evaluated_at?.toISOString() ?? null,
            });
            byRule.set(row.alert_rule_uuid, instances);
        });
        return byRule;
    }
}
