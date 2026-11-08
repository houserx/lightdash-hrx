// Shadow Run comparison (ENG-1799, ADR 0003): matches the firings that
// shadow rules would have notified in Lightdash against Grafana's alert state
// history, and classifies each difference as expected (listed with a reason)
// or unexpected.
import { ParameterError } from '../types/errors';
import type { AlertLabels } from './routingMatchers';

/** Grafana's default matching window: 5 minutes. */
export const SHADOW_RUN_DEFAULT_TOLERANCE_MS = 300_000;

/** A would-have-notified event of a shadow rule. Only `firing` counts. */
export type ShadowRunEvent = {
    ruleName: string;
    labels: AlertLabels;
    status: 'firing' | 'resolved';
    /** ISO timestamp. */
    at: string;
};

export type ShadowRunDifferenceKind =
    | 'missing_in_lightdash'
    | 'extra_in_lightdash';

/** A routing difference written down before the Shadow Run. */
export type ShadowRunExpectedDifference = {
    ruleName: string;
    kind: ShadowRunDifferenceKind;
    reason: string;
};

/** A data frame from Grafana's GET /api/v1/rules/history. */
export type GrafanaStateHistoryFrame = {
    schema: { fields: Array<{ name: string; type?: string }> };
    data: { values: unknown[][] };
};

export type ShadowRunFinding = {
    ruleName: string;
    /** ISO timestamp: Grafana's firing, or Lightdash's for an extra. */
    at: string;
    labels: AlertLabels;
    expected: boolean;
    reason?: string;
};

/** A Grafana firing Lightdash reproduced; `expected` is always true. */
export type ShadowRunMatch = ShadowRunFinding & {
    /** ISO timestamp of the matching shadow firing. */
    lightdashAt: string;
    /** Lightdash time minus Grafana time. */
    deltaMs: number;
};

export type ShadowRunReport = {
    matched: ShadowRunMatch[];
    missingInLightdash: ShadowRunFinding[];
    extraInLightdash: ShadowRunFinding[];
    /** Missing and extra findings not listed as expected. */
    unexpectedCount: number;
};

export type CompareShadowRunArgs = {
    since: string;
    shadow: ShadowRunEvent[];
    grafanaHistory: unknown;
    expectedDifferences: ShadowRunExpectedDifference[];
    toleranceMs?: number;
};

type Firing = { ruleName: string; at: number; labels: AlertLabels };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const toLabels = (value: unknown): AlertLabels => {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
    );
};

const parseTime = (value: unknown, what: string): number => {
    let ms = NaN;
    if (typeof value === 'number') ms = value;
    else if (typeof value === 'string') ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
        throw new ParameterError(`${what} is not a valid time`);
    }
    return ms;
};

/**
 * The firings (state changes into `Alerting...`) of a Grafana state history
 * frame. Throws a ParameterError when the frame is malformed.
 */
export const parseGrafanaStateHistory = (frame: unknown): Firing[] => {
    if (
        !isRecord(frame) ||
        !isRecord(frame.schema) ||
        !Array.isArray(frame.schema.fields) ||
        !isRecord(frame.data) ||
        !Array.isArray(frame.data.values)
    ) {
        throw new ParameterError(
            'Grafana history must be a data frame with schema.fields and data.values',
        );
    }
    const { fields } = frame.schema;
    const values: unknown[] = frame.data.values;
    const column = (name: string): unknown[] => {
        const index = fields.findIndex(
            (field) => isRecord(field) && field.name === name,
        );
        const col = index < 0 ? undefined : values[index];
        if (!Array.isArray(col)) {
            throw new ParameterError(`Grafana history has no "${name}" column`);
        }
        return col;
    };
    const times = column('time');
    const lines = column('line');
    if (times.length !== lines.length) {
        throw new ParameterError(
            'Grafana history columns have different lengths',
        );
    }
    return lines.flatMap((raw, row): Firing[] => {
        let line: unknown = raw;
        if (typeof raw === 'string') {
            try {
                line = JSON.parse(raw);
            } catch {
                line = undefined;
            }
        }
        if (
            !isRecord(line) ||
            typeof line.current !== 'string' ||
            typeof line.ruleTitle !== 'string'
        ) {
            throw new ParameterError(
                `Grafana history line ${row} has no ruleTitle and current state`,
            );
        }
        const at = parseTime(times[row], `Grafana history time ${row}`);
        if (!line.current.startsWith('Alerting')) return [];
        return [
            { ruleName: line.ruleTitle, at, labels: toLabels(line.labels) },
        ];
    });
};

const byTime = (a: Firing, b: Firing) =>
    a.at - b.at || a.ruleName.localeCompare(b.ruleName);

/**
 * Compares shadow firings with Grafana's firings: one-to-one by rule name
 * within the tolerance, ignoring events before `since`.
 */
export const compareShadowRun = ({
    since,
    shadow,
    grafanaHistory,
    expectedDifferences,
    toleranceMs = SHADOW_RUN_DEFAULT_TOLERANCE_MS,
}: CompareShadowRunArgs): ShadowRunReport => {
    const sinceMs = parseTime(since, 'since');
    if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
        throw new ParameterError('toleranceMs must be a non-negative number');
    }
    const grafana = parseGrafanaStateHistory(grafanaHistory)
        .filter((firing) => firing.at >= sinceMs)
        .sort(byTime);
    const lightdash = shadow
        .filter((event) => event.status === 'firing')
        .map(
            (event, index): Firing => ({
                ruleName: event.ruleName,
                at: parseTime(event.at, `shadow event ${index}`),
                labels: event.labels ?? {},
            }),
        )
        .filter((firing) => firing.at >= sinceMs)
        .sort(byTime);

    const expectedReason = (ruleName: string, kind: ShadowRunDifferenceKind) =>
        expectedDifferences.find(
            (difference) =>
                difference.ruleName === ruleName && difference.kind === kind,
        )?.reason;
    const finding = (
        firing: Firing,
        kind: ShadowRunDifferenceKind,
    ): ShadowRunFinding => {
        const reason = expectedReason(firing.ruleName, kind);
        return {
            ruleName: firing.ruleName,
            at: new Date(firing.at).toISOString(),
            labels: firing.labels,
            expected: reason !== undefined,
            ...(reason !== undefined ? { reason } : {}),
        };
    };

    // Greedy in time order: each Grafana firing takes the earliest unmatched
    // shadow firing of the same rule within the tolerance. Shadow firings too
    // early for it can't match any later Grafana firing either.
    const matched: ShadowRunMatch[] = [];
    const missingInLightdash: ShadowRunFinding[] = [];
    const used = new Set<number>();
    grafana.forEach((g) => {
        const index = lightdash.findIndex(
            (l, i) =>
                !used.has(i) &&
                l.ruleName === g.ruleName &&
                Math.abs(l.at - g.at) <= toleranceMs,
        );
        if (index < 0) {
            missingInLightdash.push(finding(g, 'missing_in_lightdash'));
            return;
        }
        used.add(index);
        const l = lightdash[index];
        matched.push({
            ruleName: g.ruleName,
            at: new Date(g.at).toISOString(),
            labels: g.labels,
            expected: true,
            lightdashAt: new Date(l.at).toISOString(),
            deltaMs: l.at - g.at,
        });
    });
    const extraInLightdash = lightdash
        .filter((_, i) => !used.has(i))
        .map((l) => finding(l, 'extra_in_lightdash'));

    return {
        matched,
        missingInLightdash,
        extraInLightdash,
        unexpectedCount: [...missingInLightdash, ...extraInLightdash].filter(
            (f) => !f.expected,
        ).length,
    };
};
