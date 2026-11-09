// Alert Rule query identity (ENG-1799, CONTRACTS §3 and §4.3). The evaluator
// queries the warehouse as the system identity `system:alert-evaluator`, never
// as the rule's author. The context carries the identity claims; a warehouse
// client that signs identity tokens (the federation flavour of Postgres)
// mints them from it, and other clients ignore it.

export const ALERT_EVALUATOR_SUBJECT = 'system:alert-evaluator';

export const ALERT_RULE_AUDIT_SOURCE = 'alert_rule';

export type AlertRuleQueryAudit = {
    /** The rule's saved description: why the query runs. */
    description: string;
    /** Alert Rules have no ticket of their own. */
    ticket: null;
    source: typeof ALERT_RULE_AUDIT_SOURCE;
    /** The Alert Rule uuid. */
    resource_uuid: string;
};

export type AlertRuleQueryContext = {
    sub: typeof ALERT_EVALUATOR_SUBJECT;
    sys: true;
    agent: false;
    projectUuid: string;
    audit: AlertRuleQueryAudit;
};

export type BuildAlertEvaluatorQueryContextArgs = {
    ruleUuid: string;
    projectUuid: string;
    description: string;
};

const requireText = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Alert Rule query context needs a non-blank ${name}`);
    }
    return value;
};

/**
 * Builds the identity an Alert Rule's query runs under. The description is
 * the audit reason, so a blank one is an error rather than an empty audit.
 */
export const buildAlertEvaluatorQueryContext = ({
    ruleUuid,
    projectUuid,
    description,
}: BuildAlertEvaluatorQueryContextArgs): AlertRuleQueryContext => ({
    sub: ALERT_EVALUATOR_SUBJECT,
    sys: true,
    agent: false,
    projectUuid: requireText(projectUuid, 'projectUuid'),
    audit: {
        description: requireText(description, 'description'),
        ticket: null,
        source: ALERT_RULE_AUDIT_SOURCE,
        resource_uuid: requireText(ruleUuid, 'ruleUuid'),
    },
});
