import {
    alertLabelsFingerprint,
    evaluateAlertCondition,
    parsePrometheusDuration,
    reduceAlertSeries,
    splitAlertSeries,
    transitionAlertInstance,
    type AlertInstanceSnapshot,
    type AlertInstanceState,
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
 * One evaluation of a rule over its query rows: every series is reduced,
 * checked against the condition and moved through the state machine from
 * its previous snapshot. A stored series missing from a non-empty result
 * counts as not meeting the condition (so a firing one resolves); once it is
 * back to normal it is removed. An empty result changes nothing here: the
 * rule's noDataState decides what happens then.
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
    const timing = {
        forMs: parsePrometheusDuration(rule.for),
        keepFiringForMs: parsePrometheusDuration(rule.keepFiringFor),
    };
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
                evaluated.set(instance.fingerprint, {
                    ...instance,
                    ...snapshot,
                    value: null,
                });
            }
        });
    return { instances: [...evaluated.values()], removedFingerprints };
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
