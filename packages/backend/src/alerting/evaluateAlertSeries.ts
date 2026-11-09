import {
    alertLabelsFingerprint,
    evaluateAlertCondition,
    parsePrometheusDuration,
    reduceAlertSeries,
    renderAlertAnnotations,
    splitAlertSeries,
    transitionAlertInstance,
    type AlertInstanceSnapshot,
    type AlertInstanceState,
    type AlertInstanceTiming,
    type AlertQueryRow,
    type AlertRule,
    type AlertSeriesLabels,
} from '@lightdash/common';

/** A series' stored state: its identity plus the state machine snapshot. */
export type AlertInstanceRecord = AlertInstanceSnapshot & {
    fingerprint: string;
    labels: AlertSeriesLabels;
    annotations: Record<string, string>;
    value: number | null;
};

export type AlertSeriesEvaluation = {
    /** Every series to store after this evaluation. */
    instances: AlertInstanceRecord[];
    /** Stored series that are gone from the result and back to normal. */
    removedFingerprints: string[];
};

type EvaluatedRule = Pick<
    AlertRule,
    | 'name'
    | 'labels'
    | 'annotations'
    | 'valueColumn'
    | 'reducer'
    | 'condition'
    | 'for'
    | 'keepFiringFor'
>;

const getAlertInstanceTiming = (
    rule: Pick<AlertRule, 'for' | 'keepFiringFor'>,
): AlertInstanceTiming => ({
    forMs: parsePrometheusDuration(rule.for),
    keepFiringForMs: parsePrometheusDuration(rule.keepFiringFor),
});

/**
 * An instance's labels: the series' labels, then the rule's labels (which
 * win on a clash, as in Prometheus), then `alertname` = the rule name.
 */
export const getAlertInstanceLabels = (
    rule: Pick<AlertRule, 'name' | 'labels'>,
    seriesLabels: AlertSeriesLabels,
): AlertSeriesLabels => ({
    ...seriesLabels,
    ...rule.labels,
    alertname: rule.name,
});

/**
 * Settles the stored series that are not in `evaluated` as not meeting the
 * condition, with no value: a firing one resolves (honouring
 * keepFiringFor), and one that is back to normal is removed.
 */
const settleMissingSeries = ({
    previous,
    evaluated,
    at,
    timing,
}: {
    previous: readonly AlertInstanceRecord[];
    evaluated: Map<string, AlertInstanceRecord>;
    at: Date;
    timing: AlertInstanceTiming;
}): AlertSeriesEvaluation => {
    const instances = new Map(evaluated);
    const removedFingerprints: string[] = [];
    previous
        .filter((instance) => !evaluated.has(instance.fingerprint))
        .forEach((instance) => {
            const snapshot = transitionAlertInstance(
                instance,
                { conditionMet: false, at },
                timing,
            );
            if (snapshot.state === 'normal') {
                removedFingerprints.push(instance.fingerprint);
            } else {
                instances.set(instance.fingerprint, {
                    ...instance,
                    ...snapshot,
                    value: null,
                });
            }
        });
    return { instances: [...instances.values()], removedFingerprints };
};

/**
 * One evaluation of a rule over its query rows: every series is reduced,
 * checked against the condition and moved through the state machine from
 * its previous snapshot. A stored series missing from a non-empty result
 * counts as not meeting the condition (so a firing one resolves); once it is
 * back to normal it is removed. An empty result changes nothing here: the
 * evaluator passes it to `evaluateAlertNoData`, which follows the rule's
 * noDataState (and a failed query to `evaluateAlertError`).
 */
export const evaluateAlertSeries = ({
    rule,
    rows,
    previous,
    at,
}: {
    rule: EvaluatedRule;
    rows: readonly AlertQueryRow[];
    previous: readonly AlertInstanceRecord[];
    at: Date;
}): AlertSeriesEvaluation => {
    if (rows.length === 0) {
        return { instances: [...previous], removedFingerprints: [] };
    }
    const timing = getAlertInstanceTiming(rule);
    const previousByFingerprint = new Map(
        previous.map((instance) => [instance.fingerprint, instance]),
    );
    const evaluated = new Map<string, AlertInstanceRecord>();
    splitAlertSeries(rows, { valueColumn: rule.valueColumn }).forEach(
        (series) => {
            const labels = getAlertInstanceLabels(rule, series.labels);
            const fingerprint = alertLabelsFingerprint(labels);
            const value = reduceAlertSeries(series.values, rule.reducer);
            const snapshot = transitionAlertInstance(
                previousByFingerprint.get(fingerprint),
                {
                    conditionMet: evaluateAlertCondition(value, rule.condition),
                    at,
                },
                timing,
            );
            evaluated.set(fingerprint, {
                ...snapshot,
                fingerprint,
                labels,
                annotations: renderAlertAnnotations(rule.annotations, {
                    labels,
                    value,
                }),
                value,
            });
        },
    );

    return settleMissingSeries({
        previous,
        evaluated,
        at,
        timing,
    });
};

/** `alertname` of the synthetic series an empty result raises. */
export const DATASOURCE_NO_DATA_ALERTNAME = 'DatasourceNoData';

/**
 * The synthetic no-data series' labels: the rule's labels (so it routes like
 * the rule's own series), `alertname` = DatasourceNoData and `rulename` =
 * the rule name.
 */
export const getAlertNoDataLabels = (
    rule: Pick<AlertRule, 'name' | 'labels'>,
): AlertSeriesLabels => ({
    ...rule.labels,
    alertname: DATASOURCE_NO_DATA_ALERTNAME,
    rulename: rule.name,
});

/**
 * The synthetic series an empty result or a failed query raises: settles
 * every stored series as not meeting the condition (so a firing one
 * resolves) and, unless `state` is `normal`, adds the synthetic series
 * - in `state` itself (`nodata` / `error`, which notify as firing), keeping
 *   its `stateSince` while it stays there, or
 * - for `alerting`, as meeting the condition, so it goes pending / firing
 *   as the rule's `for` says.
 * The synthetic series is a stored series like any other, so once the
 * query returns rows again it is missing from them and clears.
 */
const evaluateSyntheticSeries = ({
    rule,
    previous,
    at,
    state,
    labels,
    annotations,
}: {
    rule: Pick<AlertRule, 'for' | 'keepFiringFor'>;
    previous: readonly AlertInstanceRecord[];
    at: Date;
    state: 'normal' | 'alerting' | 'nodata' | 'error';
    labels: AlertSeriesLabels;
    annotations: Record<string, string>;
}): AlertSeriesEvaluation => {
    const timing = getAlertInstanceTiming(rule);
    const evaluated = new Map<string, AlertInstanceRecord>();
    if (state !== 'normal') {
        const fingerprint = alertLabelsFingerprint(labels);
        const before = previous.find((i) => i.fingerprint === fingerprint);
        const snapshot =
            state === 'alerting'
                ? transitionAlertInstance(
                      before,
                      { conditionMet: true, at },
                      timing,
                  )
                : {
                      state,
                      stateSince:
                          before?.state === state ? before.stateSince : at,
                      activeAt: null,
                      lastConditionMetAt: before?.lastConditionMetAt ?? null,
                      lastEvaluatedAt: at,
                  };
        evaluated.set(fingerprint, {
            ...snapshot,
            fingerprint,
            labels,
            annotations,
            value: null,
        });
    }
    return settleMissingSeries({ previous, evaluated, at, timing });
};

/**
 * One evaluation of a rule whose query returned no rows, following its
 * noDataState:
 * - `keep_last`: nothing changes.
 * - `normal`: every stored series is settled as not meeting the condition,
 *   so a firing one resolves.
 * - `nodata`: the same, plus a synthetic DatasourceNoData series in state
 *   `nodata` (which notifies as firing).
 * - `alerting`: the same, but the DatasourceNoData series meets the
 *   condition and goes pending / firing as the rule's `for` says.
 */
export const evaluateAlertNoData = ({
    rule,
    previous,
    at,
}: {
    rule: Pick<EvaluatedRule, 'name' | 'labels' | 'annotations'> &
        Pick<AlertRule, 'for' | 'keepFiringFor' | 'noDataState'>;
    previous: readonly AlertInstanceRecord[];
    at: Date;
}): AlertSeriesEvaluation => {
    if (rule.noDataState === 'keep_last') {
        return { instances: [...previous], removedFingerprints: [] };
    }
    const labels = getAlertNoDataLabels(rule);
    return evaluateSyntheticSeries({
        rule,
        previous,
        at,
        state: rule.noDataState,
        labels,
        annotations: renderAlertAnnotations(rule.annotations, {
            labels,
            value: null,
        }),
    });
};

/** `alertname` of the synthetic series a failed query raises. */
export const DATASOURCE_ERROR_ALERTNAME = 'DatasourceError';

/**
 * The synthetic error series' labels: the rule's labels, `alertname` =
 * DatasourceError and `rulename` = the rule name.
 */
export const getAlertErrorLabels = (
    rule: Pick<AlertRule, 'name' | 'labels'>,
): AlertSeriesLabels => ({
    ...rule.labels,
    alertname: DATASOURCE_ERROR_ALERTNAME,
    rulename: rule.name,
});

/**
 * One evaluation of a rule whose query failed with `error`, following its
 * errorState:
 * - `keep_last`: nothing changes.
 * - `error`: every stored series is settled as not meeting the condition,
 *   plus a synthetic DatasourceError series in state `error` (which
 *   notifies as firing) whose `error` annotation is the query's message.
 * - `alerting`: the same, but the DatasourceError series meets the
 *   condition and goes pending / firing as the rule's `for` says.
 */
export const evaluateAlertError = ({
    rule,
    previous,
    at,
    error,
}: {
    rule: Pick<EvaluatedRule, 'name' | 'labels' | 'annotations'> &
        Pick<AlertRule, 'for' | 'keepFiringFor' | 'errorState'>;
    previous: readonly AlertInstanceRecord[];
    at: Date;
    error: string;
}): AlertSeriesEvaluation => {
    if (rule.errorState === 'keep_last') {
        return { instances: [...previous], removedFingerprints: [] };
    }
    const labels = getAlertErrorLabels(rule);
    return evaluateSyntheticSeries({
        rule,
        previous,
        at,
        state: rule.errorState,
        labels,
        annotations: {
            ...renderAlertAnnotations(rule.annotations, {
                labels,
                value: null,
            }),
            error,
        },
    });
};

/** One series changing state in an evaluation. */
export type AlertSeriesTransition = {
    fingerprint: string;
    labels: AlertSeriesLabels;
    previousState: AlertInstanceState;
    state: AlertInstanceState;
    value: number | null;
};

/**
 * The state changes an evaluation made: every stored series whose state
 * differs from its previous one (a new series counts as previously normal,
 * so a new normal series is no change), and every removed series that was
 * not normal yet (it went to normal, with no value).
 */
export const getAlertSeriesTransitions = (
    previous: readonly AlertInstanceRecord[],
    { instances, removedFingerprints }: AlertSeriesEvaluation,
): AlertSeriesTransition[] => {
    const previousByFingerprint = new Map(
        previous.map((instance) => [instance.fingerprint, instance]),
    );
    const changed = instances.flatMap((instance) => {
        const previousState =
            previousByFingerprint.get(instance.fingerprint)?.state ?? 'normal';
        return previousState === instance.state
            ? []
            : [
                  {
                      fingerprint: instance.fingerprint,
                      labels: instance.labels,
                      previousState,
                      state: instance.state,
                      value: instance.value,
                  },
              ];
    });
    const cleared = removedFingerprints.flatMap((fingerprint) => {
        const removed = previousByFingerprint.get(fingerprint);
        return !removed || removed.state === 'normal'
            ? []
            : [
                  {
                      fingerprint,
                      labels: removed.labels,
                      previousState: removed.state,
                      state: 'normal' as const,
                      value: null,
                  },
              ];
    });
    return [...changed, ...cleared];
};
