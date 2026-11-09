/**
 * ENG-1799 importers: a source dashboard's time range and auto-refresh → the Dashboard Time
 * Range (dashboard-as-code `timeRange`). Pure. Shared by the Grafana importer and, later, the
 * Perses one.
 *
 * - `now` and `now-<n><s|m|h|d|w>` are kept. Months and years become days (1M = 30d,
 *   1y = 365d), and Grafana's rounding (`now/d`, `now-1d/d`) is dropped: a rounded `from`
 *   moves back one more unit so the window still covers the period. Both give a
 *   `time-range-adjusted` warning.
 * - Absolute bounds (ISO-8601 text or epoch milliseconds) become ISO-8601 UTC timestamps.
 * - A range that can't be read, or whose `from` is after its `to`, becomes the Grafana default
 *   `now-6h` to `now` with a `time-range-unsupported` warning. A missing range is that default
 *   with no warning, as in Grafana.
 * - The refresh interval moves to the nearest DASHBOARD_REFRESH_INTERVALS value (ties go to
 *   the longer one, which is lighter on the sources) with a `refresh-adjusted` warning. An
 *   empty or `false` refresh is off (`null`); one that can't be read is off with a
 *   `refresh-unsupported` warning.
 *
 * Chart tiles carry no `tileTimeDimensions`: imported SQL charts read the reserved
 * `${ld.parameters.__from}` and `${ld.parameters.__to}` parameters instead.
 */
import type { DashboardTimeRangeAsCode } from '../types/contentAsCode/dashboards';
import {
    DASHBOARD_REFRESH_INTERVALS,
    type DashboardRefreshInterval,
} from '../types/dashboardTimeRange';
import {
    isAbsoluteTimeExpression,
    isRelativeTimeExpression,
    parseTimeRangeDuration,
} from '../utils/timeRange';
import type { ImportWarning } from './importWarnings';

export const DEFAULT_IMPORTED_TIME_RANGE = { from: 'now-6h', to: 'now' };

type Bound = { value: string; adjusted?: string } | { error: string };

const UNIT_DAYS: Record<string, number> = { M: 30, y: 365 };
const UNIT_NAMES: Record<string, string> = {
    s: 'second',
    m: 'minute',
    h: 'hour',
    d: 'day',
    w: 'week',
    M: 'month',
    y: 'year',
};

// Grafana relative time: now, now-<n><unit>, now+<n><unit>, each optionally rounded (/<unit>).
const GRAFANA_RELATIVE =
    /^now(?:([-+])(\d+)(s|m|h|d|w|M|y))?(?:\/(s|m|h|d|w|M|y))?$/;

const relativeBound = (
    expression: string,
    side: 'from' | 'to',
): Bound | undefined => {
    const match = GRAFANA_RELATIVE.exec(expression);
    if (!match) return undefined;
    const [, sign, amountText, unitText, roundUnit] = match;
    if (sign === '+') {
        return { error: `"${expression}" is in the future` };
    }
    let amount = amountText === undefined ? 0 : Number(amountText);
    let unit = unitText ?? roundUnit ?? 'h';
    const notes: string[] = [];
    if (roundUnit !== undefined) {
        notes.push(`rounding to the ${UNIT_NAMES[roundUnit]} is dropped`);
        if (side === 'from') {
            // Rounding `from` down reaches back up to one more unit; keep that window.
            if (unitText !== undefined && unitText !== roundUnit) {
                const daysOf = (u: string) =>
                    UNIT_DAYS[u] ??
                    parseTimeRangeDuration(`1${u}`) / 86_400_000;
                amount = Math.ceil(
                    (amount * daysOf(unitText)) / daysOf(roundUnit) + 1,
                );
            } else {
                amount += 1;
            }
            unit = roundUnit;
        }
    }
    if (UNIT_DAYS[unit] !== undefined) {
        notes.push(`${unit === 'M' ? 'months' : 'years'} become days`);
        amount *= UNIT_DAYS[unit];
        unit = 'd';
    }
    const value = amount === 0 ? 'now' : `now-${amount}${unit}`;
    if (!isRelativeTimeExpression(value)) {
        return { error: `"${expression}" has no Lightdash equivalent` };
    }
    return notes.length === 0
        ? { value }
        : {
              value,
              adjusted: `"${expression}" becomes "${value}" (${notes.join(', ')}), as Lightdash has no such time expression`,
          };
};

// An ISO-8601 date or date-time with no offset, as Grafana's time picker can save.
const OFFSETLESS_TIME =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/;

const absoluteBound = (expression: string | number): Bound => {
    const text = String(expression).trim();
    let date: Date | undefined;
    let adjusted: string | undefined;
    const offsetless = OFFSETLESS_TIME.exec(text);
    if (/^\d{10,}$/.test(text)) {
        date = new Date(Number(text));
    } else if (isAbsoluteTimeExpression(text)) {
        date = new Date(text);
    } else if (offsetless) {
        date = new Date(`${offsetless[1]}T${offsetless[2] ?? '00:00:00'}Z`);
        adjusted = `"${text}" has no time zone offset, so it is read as UTC`;
    }
    if (date === undefined || Number.isNaN(date.getTime())) {
        return { error: `"${text}" is not a time Lightdash can read` };
    }
    const value = date.toISOString();
    return adjusted === undefined ? { value } : { value, adjusted };
};

/** How far back from now a Lightdash relative expression reaches, in milliseconds. */
const relativeReachMs = (expression: string): number =>
    expression === 'now' ? 0 : parseTimeRangeDuration(expression.slice(4));

const readBound = (raw: unknown, side: 'from' | 'to'): Bound => {
    if (typeof raw === 'number') return absoluteBound(raw);
    if (typeof raw !== 'string' || raw.trim() === '') {
        return { error: `the ${side} time is missing` };
    }
    const text = raw.trim();
    return relativeBound(text, side) ?? absoluteBound(text);
};

/** Millisecond length of a Grafana refresh such as `5s`, `1m` or `1d`; undefined if unreadable. */
const refreshMs = (refresh: string): number | undefined => {
    const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(refresh.trim());
    if (!match) return undefined;
    const ms =
        match[2] === 'ms'
            ? Number(match[1])
            : parseTimeRangeDuration(`${match[1]}${match[2]}`);
    return ms > 0 ? ms : undefined;
};

const nearestRefreshInterval = (ms: number): DashboardRefreshInterval =>
    DASHBOARD_REFRESH_INTERVALS.reduce((best, candidate) => {
        const distance = Math.abs(parseTimeRangeDuration(candidate) - ms);
        const bestDistance = Math.abs(parseTimeRangeDuration(best) - ms);
        // Intervals are ascending, so `<=` sends ties to the longer interval.
        return distance <= bestDistance ? candidate : best;
    });

export type ImportedTimeRange = {
    timeRange: DashboardTimeRangeAsCode;
    warnings: ImportWarning[];
};

/**
 * Converts a dashboard time range (`{from, to}`) and refresh into a Dashboard Time Range.
 * `refresh` is a duration string, or empty/false/undefined for off.
 */
export const importDashboardTimeRange = (
    time: unknown,
    refresh: unknown,
): ImportedTimeRange => {
    const warnings: ImportWarning[] = [];
    let range = DEFAULT_IMPORTED_TIME_RANGE;
    if (time !== undefined && time !== null) {
        const record =
            typeof time === 'object' && !Array.isArray(time)
                ? (time as Record<string, unknown>)
                : {};
        const from = readBound(record.from, 'from');
        const to = readBound(record.to, 'to');
        const fail = [from, to].find(
            (b): b is { error: string } => 'error' in b,
        );
        const fromValue = 'value' in from ? from.value : '';
        const toValue = 'value' in to ? to.value : '';
        const bothRelative = isRelativeTimeExpression(fromValue);
        const outOfOrder =
            fail === undefined &&
            bothRelative === isRelativeTimeExpression(toValue) &&
            (bothRelative
                ? relativeReachMs(fromValue) < relativeReachMs(toValue)
                : Date.parse(fromValue) > Date.parse(toValue));
        if (fail !== undefined || outOfOrder) {
            warnings.push({
                code: 'time-range-unsupported',
                message: `The time range is not imported (${
                    fail?.error ?? `"${fromValue}" is after "${toValue}"`
                }); the dashboard uses ${DEFAULT_IMPORTED_TIME_RANGE.from} to ${DEFAULT_IMPORTED_TIME_RANGE.to}`,
            });
        } else {
            range = { from: fromValue, to: toValue };
            [from, to].forEach((bound) => {
                if ('adjusted' in bound && bound.adjusted !== undefined) {
                    warnings.push({
                        code: 'time-range-adjusted',
                        message: `The time range ${bound.adjusted}`,
                    });
                }
            });
        }
    }

    let refreshInterval: DashboardRefreshInterval | null = null;
    const refreshValue = typeof refresh === 'string' ? refresh.trim() : refresh;
    // Grafana writes an empty string or `false` when auto-refresh is off.
    if (
        refreshValue !== undefined &&
        refreshValue !== null &&
        refreshValue !== false &&
        refreshValue !== ''
    ) {
        const ms =
            typeof refreshValue === 'string'
                ? refreshMs(refreshValue)
                : undefined;
        if (ms === undefined) {
            warnings.push({
                code: 'refresh-unsupported',
                message: `The refresh ${JSON.stringify(refreshValue)} is not a duration, so auto-refresh is off`,
            });
        } else {
            refreshInterval = nearestRefreshInterval(ms);
            if (parseTimeRangeDuration(refreshInterval) !== ms) {
                warnings.push({
                    code: 'refresh-adjusted',
                    message: `The refresh "${String(refreshValue)}" becomes "${refreshInterval}", the nearest interval Lightdash offers (${DASHBOARD_REFRESH_INTERVALS.join(', ')})`,
                });
            }
        }
    }

    return {
        timeRange: { ...range, refreshInterval, tileTimeDimensions: {} },
        warnings,
    };
};
