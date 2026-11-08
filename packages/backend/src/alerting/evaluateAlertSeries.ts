import {
    alertLabelsFingerprint,
    evaluateAlertCondition,
    parsePrometheusDuration,
    reduceAlertSeries,
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
 * noDataState.
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
                annotations: rule.annotations,
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
 * One evaluation of a rule whose query returned no rows, following its
 * noDataState:
 * - `keep_last`: nothing changes.
 * - `normal`: every stored series is settled as not meeting the condition,
 *   so a firing one resolves.
 * - `nodata`: the same, plus a synthetic DatasourceNoData series in state
 *   `nodata` (which notifies as firing).
 * - `alerting`: the same, but the DatasourceNoData series meets the
 *   condition and goes pending / firing as the rule's `for` says.
 * The DatasourceNoData series is a stored series like any other, so once
 * the query returns rows again it is missing from them and clears.
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
    const timing = getAlertInstanceTiming(rule);
    const evaluated = new Map<string, AlertInstanceRecord>();
    if (rule.noDataState !== 'normal') {
        const labels = getAlertNoDataLabels(rule);
        const fingerprint = alertLabelsFingerprint(labels);
        const before = previous.find((i) => i.fingerprint === fingerprint);
        const snapshot =
            rule.noDataState === 'nodata'
                ? {
                      state: 'nodata' as const,
                      stateSince:
                          before?.state === 'nodata' ? before.stateSince : at,
                      activeAt: null,
                      lastConditionMetAt: before?.lastConditionMetAt ?? null,
                      lastEvaluatedAt: at,
                  }
                : transitionAlertInstance(
                      before,
                      { conditionMet: true, at },
                      timing,
                  );
        evaluated.set(fingerprint, {
            ...snapshot,
            fingerprint,
            labels,
            annotations: rule.annotations,
            value: null,
        });
    }
    return settleMissingSeries({ previous, evaluated, at, timing });
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
