/**
 * Prometheus-style durations for Alert Rules (`for`, `keepFiringFor`,
 * evaluation intervals, Notification Route timings).
 *
 * Follows Prometheus' `model.ParseDuration`: one or more `<integer><unit>`
 * parts with units `y w d h m s ms`, each unit at most once and in
 * descending order (`1h30m`, not `30m1h`). A bare `0` is accepted. Years are
 * 365 days and weeks 7 days. Negative values, spaces and fractions are
 * rejected.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

// Largest unit first: parsing requires this order, formatting uses it.
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
    ['y', MS_PER_YEAR],
    ['w', MS_PER_WEEK],
    ['d', MS_PER_DAY],
    ['h', MS_PER_HOUR],
    ['m', MS_PER_MINUTE],
    ['s', MS_PER_SECOND],
    ['ms', 1],
];

const DURATION_PATTERN =
    /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/;

/**
 * Parses a Prometheus duration string (e.g. `30s`, `5m`, `1h30m`) into
 * milliseconds. Throws on anything Prometheus would reject.
 */
export const parsePrometheusDuration = (value: string): number => {
    if (typeof value !== 'string') {
        throw new Error('Duration must be a string');
    }
    if (value === '0') {
        return 0;
    }
    const match = value === '' ? null : DURATION_PATTERN.exec(value);
    if (!match) {
        throw new Error(
            `Invalid duration "${value}": expected a Prometheus duration such as 30s, 5m or 1h30m`,
        );
    }
    const total = DURATION_UNITS.reduce((sum, [, unitMs], index) => {
        const amount = match[index + 1];
        return amount === undefined ? sum : sum + Number(amount) * unitMs;
    }, 0);
    if (!Number.isSafeInteger(total)) {
        throw new Error(`Invalid duration "${value}": too large`);
    }
    return total;
};

/**
 * Formats milliseconds as a Prometheus duration string using the largest
 * units first (`3600000` → `1h`, `5400000` → `1h30m`, `0` → `0s`).
 */
export const formatPrometheusDuration = (ms: number): string => {
    if (!Number.isSafeInteger(ms) || ms < 0) {
        throw new Error(
            `Invalid duration ${ms}: expected a non-negative whole number of milliseconds`,
        );
    }
    if (ms === 0) {
        return '0s';
    }
    let remaining = ms;
    return DURATION_UNITS.reduce((out, [unit, unitMs]) => {
        const amount = Math.floor(remaining / unitMs);
        if (amount === 0) {
            return out;
        }
        remaining -= amount * unitMs;
        return `${out}${amount}${unit}`;
    }, '');
};
