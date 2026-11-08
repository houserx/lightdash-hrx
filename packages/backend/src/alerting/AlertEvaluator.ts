import {
    buildAlertEvaluatorQueryContext,
    resolveAlertQueryParameters,
    substituteAlertQueryParameters,
    type AlertRuleQueryContext,
    type WarehouseClient,
} from '@lightdash/common';
import { type AlertRuleModel } from './AlertRuleModel';

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
    warehouseClients: AlertWarehouseClients;
};

/**
 * Evaluates Alert Rules: runs a rule's SQL through the project's
 * WarehouseClient as `system:alert-evaluator`, over the window that ends at
 * the scheduled time.
 */
export class AlertEvaluator {
    private readonly alertRuleModel: AlertRuleModel;

    private readonly warehouseClients: AlertWarehouseClients;

    constructor(args: AlertEvaluatorArgs) {
        this.alertRuleModel = args.alertRuleModel;
        this.warehouseClients = args.warehouseClients;
    }

    async evaluateRule(
        ruleUuid: string,
        { scheduledAt }: { scheduledAt: Date },
    ): Promise<AlertEvaluationOutcome> {
        const rule = await this.alertRuleModel.findByUuid(ruleUuid);
        // A job can outlive its rule; there is nothing left to evaluate.
        if (!rule) return { status: 'skipped', reason: 'not_found' };

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
        await warehouseClient.runQuery(sql, {
            alert_rule_uuid: rule.uuid,
            project_uuid: rule.projectUuid,
        });
        return { status: 'evaluated' };
    }
}
