import {
    type AlertCondition,
    type AlertInstanceState,
    type AlertStateHistoryEntry,
} from '@lightdash/common';

export const ALERT_STATE_LABELS: Record<AlertInstanceState, string> = {
    firing: 'Firing',
    pending: 'Pending',
    normal: 'Normal',
    resolved: 'Resolved',
    nodata: 'No data',
    error: 'Error',
};

/**
 * Whether `labels` match the Alert Rules list's Label filter: comma or space
 * separated terms, all of which must match. `key=value` matches that exact
 * label, `key=` any rule with the key, and a bare word any label key or value
 * containing it (case-insensitive).
 */
export const matchesLabelFilter = (
    labels: Record<string, string>,
    filter: string,
): boolean =>
    filter
        .split(/[\s,]+/)
        .filter(Boolean)
        .every((term) => {
            const eq = term.indexOf('=');
            if (eq === -1) {
                const needle = term.toLowerCase();
                return Object.entries(labels).some(
                    ([key, value]) =>
                        key.toLowerCase().includes(needle) ||
                        value.toLowerCase().includes(needle),
                );
            }
            const key = term.slice(0, eq);
            const value = term.slice(eq + 1);
            if (!(key in labels)) return false;
            return value === '' || labels[key] === value;
        });

const RANGE_OPERATOR_LABELS = {
    within_range: 'within',
    outside_range: 'outside',
} as const;

/** A rule's condition as one line, e.g. `last(value) > 90`. */
export const formatAlertCondition = (
    reducer: string,
    valueColumn: string,
    condition: AlertCondition,
): string => {
    const value = `${reducer}(${valueColumn})`;
    if ('min' in condition)
        return `${value} ${RANGE_OPERATOR_LABELS[condition.operator]} (${condition.min}, ${condition.max})`;
    return `${value} ${condition.operator} ${condition.threshold}`;
};

/** `key=value` pairs of a label set, in the order given. */
export const formatLabels = (labels: Record<string, string>): string[] =>
    Object.entries(labels).map(([key, value]) => `${key}=${value}`);

/**
 * The headline of a state history entry: `Normal → Firing` for a series
 * transition, `Skipped evaluation (overrun)` for a skipped slot.
 */
export const describeHistoryEntry = (entry: AlertStateHistoryEntry): string =>
    entry.type === 'transition'
        ? `${ALERT_STATE_LABELS[entry.previousState] ?? entry.previousState} → ${ALERT_STATE_LABELS[entry.state] ?? entry.state}`
        : `Skipped evaluation (${entry.reason})`;
