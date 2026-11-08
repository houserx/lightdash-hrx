// Alert Rule per-series state machine (ENG-1799).
//
// One evaluation moves a series through
//   normal -> pending -> firing -> resolved -> normal
// honouring the rule's `for` (how long the condition must hold before the
// series fires) and `keepFiringFor` (how long a firing series keeps firing
// after the condition clears). The function is pure: the caller stores the
// returned snapshot and passes it back on the next evaluation.
//
// `nodata` and `error` are part of the state set (CONTRACTS 4.3) but are set
// by the evaluator, not by this transition. A series coming out of either is
// treated like a series that is not firing.

export const ALERT_INSTANCE_STATES = [
    'normal',
    'pending',
    'firing',
    'resolved',
    'nodata',
    'error',
] as const;

export type AlertInstanceState = (typeof ALERT_INSTANCE_STATES)[number];

export const isAlertInstanceState = (
    value: unknown,
): value is AlertInstanceState =>
    typeof value === 'string' &&
    (ALERT_INSTANCE_STATES as readonly string[]).includes(value);

/** A timestamp as a Date, an ISO string (e.g. from JSON) or epoch ms. */
export type AlertTimestamp = Date | string | number;

export type AlertInstanceTiming = {
    /** The rule's `for`: how long the condition must hold before firing. */
    forMs: number;
    /** The rule's `keepFiringFor`: how long to keep firing once it clears. */
    keepFiringForMs: number;
};

export type AlertInstanceEvaluation = {
    conditionMet: boolean;
    /** When the evaluation ran. */
    at: AlertTimestamp;
};

export type AlertInstanceSnapshot = {
    state: AlertInstanceState;
    /** When the series entered its current state. */
    stateSince: Date;
    /** When the condition started holding in the current episode (pending or firing), else null. */
    activeAt: Date | null;
    /** The last evaluation at which the condition held, or null if it never has. */
    lastConditionMetAt: Date | null;
    /** The time of the evaluation that produced this snapshot. */
    lastEvaluatedAt: Date;
};

const toDate = (value: AlertTimestamp, what: string): Date => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid alert instance timestamp for ${what}`);
    }
    return date;
};

const toOptionalDate = (
    value: AlertTimestamp | null | undefined,
    what: string,
): Date | null =>
    value === null || value === undefined ? null : toDate(value, what);

const checkDuration = (ms: number, what: string): void => {
    if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`${what} must be a non-negative number of ms`);
    }
};

/**
 * Applies one evaluation to a series' state. Pass `undefined` for a series
 * that has never been evaluated.
 *
 * - The condition holds: a quiet series goes pending, or straight to firing
 *   when `for` is 0. A pending series fires once the condition has held for
 *   `for` (measured from the first evaluation that met it).
 * - The condition clears: a pending series returns to normal. A firing series
 *   keeps firing until `keepFiringFor` has passed since the condition last
 *   held, then resolves. A resolved series returns to normal on the next
 *   evaluation that does not meet the condition.
 */
export const transitionAlertInstance = (
    previous: AlertInstanceSnapshot | undefined | null,
    evaluation: AlertInstanceEvaluation,
    timing: AlertInstanceTiming,
): AlertInstanceSnapshot => {
    checkDuration(timing.forMs, 'forMs');
    checkDuration(timing.keepFiringForMs, 'keepFiringForMs');
    const at = toDate(evaluation.at, 'at');
    const prevState = previous?.state;
    const prevSince = previous ? toDate(previous.stateSince, 'stateSince') : at;
    const prevActiveAt = toOptionalDate(previous?.activeAt, 'activeAt');
    const prevLastMet = toOptionalDate(
        previous?.lastConditionMetAt,
        'lastConditionMetAt',
    );

    const enter = (
        state: AlertInstanceState,
        activeAt: Date | null,
        lastConditionMetAt: Date | null,
    ): AlertInstanceSnapshot => ({
        state,
        stateSince: state === prevState ? prevSince : at,
        activeAt,
        lastConditionMetAt,
        lastEvaluatedAt: at,
    });

    if (evaluation.conditionMet) {
        if (prevState === 'firing') {
            return enter('firing', prevActiveAt ?? at, at);
        }
        if (prevState === 'pending') {
            const activeAt = prevActiveAt ?? prevSince;
            const held = at.getTime() - activeAt.getTime();
            return enter(
                held >= timing.forMs ? 'firing' : 'pending',
                activeAt,
                at,
            );
        }
        // normal, resolved, nodata, error or never evaluated: a new episode.
        return enter(timing.forMs === 0 ? 'firing' : 'pending', at, at);
    }

    if (prevState === 'firing') {
        const lastMet = prevLastMet ?? prevSince;
        const cleared = at.getTime() - lastMet.getTime();
        if (cleared < timing.keepFiringForMs) {
            return enter('firing', prevActiveAt, prevLastMet);
        }
        return enter('resolved', null, prevLastMet);
    }
    // pending falls back, resolved settles; anything else stays normal.
    return enter('normal', null, prevLastMet);
};
