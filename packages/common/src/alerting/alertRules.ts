// Alert Rule API types (ENG-1799): what /api/v2/projects/{uuid}/alerting/rules
// accepts and returns. The backend, frontend and CLI share these.
import { type AlertErrorState, type AlertNoDataState } from './asCode';
import { type AlertCondition } from './conditions';
import { type AlertReducer } from './reducers';
import { type AlertInstanceState } from './stateMachine';

/** Documented defaults for the optional Alert Rule fields. */
export const ALERT_RULE_DEFAULTS = {
    valueColumn: 'value',
    reducer: 'last',
    for: '0s',
    keepFiringFor: '0s',
    interval: '1m',
    timeRange: '10m',
    noDataState: 'nodata',
    errorState: 'error',
    paused: false,
    shadow: false,
} as const satisfies Partial<AlertRuleDefinition>;

/** The editable part of an Alert Rule; also the body of a saved version. */
export type AlertRuleDefinition = {
    name: string;
    description: string;
    /** The folder (a space of the project), or null. */
    spaceUuid: string | null;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    query: string;
    valueColumn: string;
    reducer: AlertReducer;
    condition: AlertCondition;
    for: string;
    keepFiringFor: string;
    interval: string;
    timeRange: string;
    noDataState: AlertNoDataState;
    errorState: AlertErrorState;
    paused: boolean;
    shadow: boolean;
};

/** Body of `POST /rules`: the required fields plus any optional ones. */
export type CreateAlertRule = Pick<
    AlertRuleDefinition,
    'name' | 'description' | 'query' | 'condition'
> &
    Partial<AlertRuleDefinition> & {
        /** Defaults to one derived from the name, unique in the project. */
        slug?: string;
    };

/** Body of `PATCH /rules/:ruleUuid`: any subset of the definition. */
export type UpdateAlertRule = Partial<AlertRuleDefinition>;

export type AlertRule = AlertRuleDefinition & {
    uuid: string;
    projectUuid: string;
    slug: string;
    /** Uploaded as code; read-only in the API and UI. */
    managed: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
    createdByUserUuid: string | null;
    updatedByUserUuid: string | null;
};

/** A rule's aggregate state; a rule never evaluated is `normal`. */
export type AlertRuleState = Exclude<AlertInstanceState, 'resolved'>;

export type AlertRuleInstance = {
    fingerprint: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    state: AlertInstanceState;
    value: number | null;
    /** When the series entered its current state (ISO). */
    since: string;
    activeAt: string | null;
    lastEvaluatedAt: string | null;
};

export type AlertRuleSummary = AlertRule & { state: AlertRuleState };

export type AlertRuleWithInstances = AlertRuleSummary & {
    instances: AlertRuleInstance[];
};

/** Highest first: the aggregate state is the first one any series is in. */
export const ALERT_RULE_STATE_PRECEDENCE: readonly AlertRuleState[] = [
    'firing',
    'error',
    'nodata',
    'pending',
    'normal',
];

/** Aggregate state of a rule from its series' states. */
export const getAlertRuleState = (
    instanceStates: readonly AlertInstanceState[],
): AlertRuleState =>
    ALERT_RULE_STATE_PRECEDENCE.find((state) =>
        instanceStates.includes(state),
    ) ?? 'normal';
