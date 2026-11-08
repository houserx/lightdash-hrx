import { type AlertInstanceState } from '@lightdash/common';

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
