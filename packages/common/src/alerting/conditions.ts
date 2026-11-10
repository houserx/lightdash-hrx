// Alert Rule conditions (ENG-1799): check a reduced value against a threshold
// or a range. Semantics follow Grafana's threshold expression: ranges are
// exclusive at both ends, and a missing (null) value never fires.

export const ALERT_THRESHOLD_OPERATORS = [
    '>',
    '<',
    '>=',
    '<=',
    '==',
    '!=',
] as const;

export type AlertThresholdOperator = (typeof ALERT_THRESHOLD_OPERATORS)[number];

export const ALERT_RANGE_OPERATORS = ['within_range', 'outside_range'] as const;

export type AlertRangeOperator = (typeof ALERT_RANGE_OPERATORS)[number];

export type AlertConditionOperator =
    | AlertThresholdOperator
    | AlertRangeOperator;

export const ALERT_CONDITION_OPERATORS: readonly AlertConditionOperator[] = [
    ...ALERT_THRESHOLD_OPERATORS,
    ...ALERT_RANGE_OPERATORS,
];

export type AlertThresholdCondition = {
    operator: AlertThresholdOperator;
    threshold: number;
};

export type AlertRangeCondition = {
    operator: AlertRangeOperator;
    min: number;
    max: number;
};

export type AlertCondition = AlertThresholdCondition | AlertRangeCondition;

export const isAlertConditionOperator = (
    value: unknown,
): value is AlertConditionOperator =>
    typeof value === 'string' &&
    (ALERT_CONDITION_OPERATORS as readonly string[]).includes(value);

/**
 * Whether a reduced value meets the condition.
 * `within_range` is true when min < value < max; `outside_range` when
 * value < min or value > max (both exclusive; a reversed range is
 * normalised). A null or undefined value gives `false` for every operator.
 */
export const evaluateAlertCondition = (
    value: number | null | undefined,
    condition: AlertCondition,
): boolean => {
    if (value === null || value === undefined) return false;
    switch (condition.operator) {
        case '>':
            return value > condition.threshold;
        case '<':
            return value < condition.threshold;
        case '>=':
            return value >= condition.threshold;
        case '<=':
            return value <= condition.threshold;
        case '==':
            return value === condition.threshold;
        case '!=':
            return value !== condition.threshold;
        case 'within_range':
        case 'outside_range': {
            const low = Math.min(condition.min, condition.max);
            const high = Math.max(condition.min, condition.max);
            return condition.operator === 'within_range'
                ? value > low && value < high
                : value < low || value > high;
        }
        default: {
            const unknown: never = condition;
            throw new Error(
                `Unknown alert condition operator: ${String(
                    (unknown as { operator?: unknown }).operator,
                )}`,
            );
        }
    }
};
