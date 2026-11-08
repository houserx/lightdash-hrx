import {
    isAbsoluteTimeExpression,
    isRelativeTimeExpression,
    resolveTimeRange,
    type TimeRangeInput,
} from '@lightdash/common';

/** Quick relative ranges offered by the time range control, all ending at now. */
export const QUICK_TIME_RANGES: readonly TimeRangeInput[] = [
    { from: 'now-5m', to: 'now' },
    { from: 'now-15m', to: 'now' },
    { from: 'now-30m', to: 'now' },
    { from: 'now-1h', to: 'now' },
    { from: 'now-3h', to: 'now' },
    { from: 'now-6h', to: 'now' },
    { from: 'now-12h', to: 'now' },
    { from: 'now-24h', to: 'now' },
    { from: 'now-2d', to: 'now' },
    { from: 'now-7d', to: 'now' },
    { from: 'now-30d', to: 'now' },
];

const UNIT_NAMES: Record<string, string> = {
    s: 'second',
    m: 'minute',
    h: 'hour',
    d: 'day',
    w: 'week',
};

const LAST_PATTERN = /^now-(\d+)([smhdw])$/;

/**
 * Human label for a time range: `Last 6 hours` for `now-6h` to `now`,
 * otherwise the two bounds as written.
 */
export const getTimeRangeLabel = (range: TimeRangeInput): string => {
    const match = LAST_PATTERN.exec(range.from.trim());
    if (match && range.to.trim() === 'now') {
        const amount = Number(match[1]);
        const unit = UNIT_NAMES[match[2]];
        return `Last ${amount} ${unit}${amount === 1 ? '' : 's'}`;
    }
    return `${range.from} to ${range.to}`;
};

export const isSameTimeRange = (a: TimeRangeInput, b: TimeRangeInput) =>
    a.from.trim() === b.from.trim() && a.to.trim() === b.to.trim();

const isTimeExpression = (value: string) =>
    isRelativeTimeExpression(value) || isAbsoluteTimeExpression(value);

/**
 * Validates a From/To pair typed by the user. Returns an error message, or
 * undefined when the range can be applied.
 */
export const getTimeRangeInputError = (
    range: TimeRangeInput,
): string | undefined => {
    if (!isTimeExpression(range.from)) {
        return 'From must be an ISO-8601 time with an offset, or now-<n><s|m|h|d|w>';
    }
    if (!isTimeExpression(range.to)) {
        return 'To must be an ISO-8601 time with an offset, or now-<n><s|m|h|d|w>';
    }
    try {
        resolveTimeRange(range);
    } catch {
        return 'From must not be after To';
    }
    return undefined;
};
