import {
    buildAlertEvaluatorQueryContext,
    evaluateAlertCondition,
    getErrorMessage,
    resolveAlertQueryParameters,
    substituteAlertQueryParameters,
    type AlertQueryRow,
    type AlertRule,
    type AlertRuleDefinition,
    type AlertRulePreview,
    type AlertRuleQueryContext,
    type WarehouseClient,
} from '@lightdash/common';
import { randomUUID } from 'crypto';
import { type AlertInstanceModel } from './AlertInstanceModel';
import { type AlertRuleModel } from './AlertRuleModel';
import { type AlertScheduleModel } from './AlertScheduleModel';
import {
    evaluateAlertSeries,
    getAlertSeriesTransitions,
    type AlertSeriesEvaluation,
} from './evaluateAlertSeries';

export type AlertEvaluationOutcome = {
    status: 'evaluated' | 'skipped';
    reason?: string;
};

/** Opens the project's WarehouseClient for the given query identity. */
export type AlertWarehouseClients = {
    getWarehouseClient(args: {
        projectUuid: string;
        context: AlertRuleQueryContext;
    }): Promise<Pick<WarehouseClient, 'runQuery'>>;
};

type AlertEvaluatorArgs = {
    alertRuleModel: AlertRuleModel;
    alertInstanceModel: AlertInstanceModel;
    alertScheduleModel: Pick<
        AlertScheduleModel,
        'claimEvaluationSlot' | 'releaseEvaluationSlot'
    >;
    warehouseClients: AlertWarehouseClients;
};

/**
 * Evaluates Alert Rules: runs a rule's SQL through the project's
 * WarehouseClient as `system:alert-evaluator`, over the window that ends at
 * the scheduled time, then gives every series of the result its own state
 * and value, stored per series in `alert_instances`. Every state change is
 * written to `alert_state_history`. Paused rules are skipped without
 * running their query. With several workers each scheduled slot is
 * evaluated once: a worker claims the slot on the rule's row before it runs
 * the query, and a worker that finds the slot (or a later one) already
 * claimed skips with reason `duplicate`. `previewRule` runs an unsaved rule once and stores
 * nothing.
 */
export class AlertEvaluator {
    private readonly alertRuleModel: AlertRuleModel;

    private readonly alertInstanceModel: AlertInstanceModel;

    private readonly alertScheduleModel: AlertEvaluatorArgs['alertScheduleModel'];

    private readonly warehouseClients: AlertWarehouseClients;

    constructor(args: AlertEvaluatorArgs) {
        this.alertRuleModel = args.alertRuleModel;
        this.alertInstanceModel = args.alertInstanceModel;
        this.alertScheduleModel = args.alertScheduleModel;
        this.warehouseClients = args.warehouseClients;
    }

    async evaluateRule(
        ruleUuid: string,
        { scheduledAt }: { scheduledAt: Date },
    ): Promise<AlertEvaluationOutcome> {
        const rule = await this.alertRuleModel.findByUuid(ruleUuid);
        // A job can outlive its rule; there is nothing left to evaluate.
        if (!rule) return { status: 'skipped', reason: 'not_found' };
        // A paused rule runs no query and keeps its stored series as they
        // are until it is unpaused.
        if (rule.paused) return { status: 'skipped', reason: 'paused' };

        // Another worker is evaluating, or has evaluated, this slot or a
        // later one.
        const { claimed, previous } =
            await this.alertScheduleModel.claimEvaluationSlot(
                rule.uuid,
                scheduledAt,
            );
        if (!claimed) return { status: 'skipped', reason: 'duplicate' };
        try {
            await this.evaluateClaimedRule(rule, scheduledAt);
        } catch (error) {
            // Give the slot back so a retry of this job evaluates it again.
            await this.alertScheduleModel.releaseEvaluationSlot(
                rule.uuid,
                scheduledAt,
                previous,
            );
            throw error;
        }
        return { status: 'evaluated' };
    }

    private async evaluateClaimedRule(
        rule: AlertRule,
        scheduledAt: Date,
    ): Promise<void> {
        const rows = await this.runRuleQuery({
            ruleUuid: rule.uuid,
            projectUuid: rule.projectUuid,
            rule,
            at: scheduledAt,
        });
        const previous = await this.alertInstanceModel.listForRule(rule.uuid);
        const evaluation = evaluateAlertSeries({
            rule,
            rows,
            previous,
            at: scheduledAt,
        });
        await this.alertInstanceModel.save(
            {
                projectUuid: rule.projectUuid,
                ruleUuid: rule.uuid,
                at: scheduledAt,
            },
            {
                ...evaluation,
                transitions: getAlertSeriesTransitions(previous, evaluation),
            },
        );
    }

    /**
     * "Test rule": runs an (unsaved) rule's query once over the window that
     * ends at `at`, and gives every series its value, whether the condition
     * holds and the state it would enter as a new series. It reads and
     * writes no stored state. The query runs under the evaluator's identity,
     * as it would once saved; an unsaved rule has no uuid, so a fresh one
     * per preview stands in as the audit's resource uuid.
     */
    async previewRule({
        projectUuid,
        rule,
        at,
    }: {
        projectUuid: string;
        rule: AlertRuleDefinition;
        at: Date;
    }): Promise<AlertRulePreview> {
        const evaluatedAt = at.toISOString();
        let evaluation: AlertSeriesEvaluation;
        try {
            const rows = await this.runRuleQuery({
                ruleUuid: randomUUID(),
                projectUuid,
                rule,
                at,
                tags: { alert_rule_preview: 'true' },
            });
            evaluation = evaluateAlertSeries({ rule, rows, previous: [], at });
        } catch (error) {
            return {
                evaluatedAt,
                series: [],
                error: getErrorMessage(error),
            };
        }
        return {
            evaluatedAt,
            series: evaluation.instances.map((instance) => ({
                labels: instance.labels,
                value: instance.value,
                conditionMet: evaluateAlertCondition(
                    instance.value,
                    rule.condition,
                ),
                state: instance.state,
            })),
            error: null,
        };
    }

    /** Runs the rule's SQL, time parameters resolved, as the evaluator. */
    private async runRuleQuery({
        ruleUuid,
        projectUuid,
        rule,
        at,
        tags = {},
    }: {
        ruleUuid: string;
        projectUuid: string;
        rule: Pick<AlertRuleDefinition, 'query' | 'timeRange' | 'description'>;
        at: Date;
        tags?: Record<string, string>;
    }): Promise<AlertQueryRow[]> {
        const sql = substituteAlertQueryParameters(
            rule.query,
            resolveAlertQueryParameters({ at, timeRange: rule.timeRange }),
        );
        const warehouseClient = await this.warehouseClients.getWarehouseClient({
            projectUuid,
            context: buildAlertEvaluatorQueryContext({
                ruleUuid,
                projectUuid,
                description: rule.description,
            }),
        });
        const { rows } = await warehouseClient.runQuery(sql, {
            alert_rule_uuid: ruleUuid,
            project_uuid: projectUuid,
            ...tags,
        });
        return rows;
    }
}
