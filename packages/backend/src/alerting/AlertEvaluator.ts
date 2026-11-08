import {
    buildAlertEvaluatorQueryContext,
    resolveAlertQueryParameters,
    substituteAlertQueryParameters,
    type AlertRuleQueryContext,
    type WarehouseClient,
} from '@lightdash/common';
import { type AlertInstanceModel } from './AlertInstanceModel';
import { type AlertRuleModel } from './AlertRuleModel';
import {
    evaluateAlertSeries,
    getAlertSeriesTransitions,
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
    warehouseClients: AlertWarehouseClients;
};

/**
 * Evaluates Alert Rules: runs a rule's SQL through the project's
 * WarehouseClient as `system:alert-evaluator`, over the window that ends at
 * the scheduled time, then gives every series of the result its own state
 * and value, stored per series in `alert_instances`. Every state change is
 * written to `alert_state_history`. Paused rules are skipped without
 * running their query.
 */
export class AlertEvaluator {
    private readonly alertRuleModel: AlertRuleModel;

    private readonly alertInstanceModel: AlertInstanceModel;

    private readonly warehouseClients: AlertWarehouseClients;

    constructor(args: AlertEvaluatorArgs) {
        this.alertRuleModel = args.alertRuleModel;
        this.alertInstanceModel = args.alertInstanceModel;
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

        const sql = substituteAlertQueryParameters(
            rule.query,
            resolveAlertQueryParameters({
                at: scheduledAt,
                timeRange: rule.timeRange,
            }),
        );
        const warehouseClient = await this.warehouseClients.getWarehouseClient({
            projectUuid: rule.projectUuid,
            context: buildAlertEvaluatorQueryContext({
                ruleUuid: rule.uuid,
                projectUuid: rule.projectUuid,
                description: rule.description,
            }),
        });
        const { rows } = await warehouseClient.runQuery(sql, {
            alert_rule_uuid: rule.uuid,
            project_uuid: rule.projectUuid,
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
        return { status: 'evaluated' };
    }
}
