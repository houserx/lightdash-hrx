import { type DateZoom } from '../types/api/paginatedQuery';
import { type LightdashProjectParameter } from '../types/lightdashProjectConfig';
import {
    type ParameterDefinitions,
    type ParametersValuesMap,
    type ParameterValue,
} from '../types/parameters';
import { getGranularityReferenceValue } from '../types/timeFrames';
import {
    getReservedTimeParameterValues,
    type ReservedTimeParameterValues,
    type TimeRangeInput,
} from '../utils/timeRange';

/** Context from which reserved parameters resolve their values. */
export type ReservedParameterContext = {
    dateZoom: DateZoom | undefined;
    /** Dashboard Time Range (or Investigate range); absent when none applies. */
    timeRange?: TimeRangeInput;
    /** Refresh interval relative ranges round down to (e.g. '1m'); none means 10s. */
    refreshInterval?: string | null;
    /** Clock `now` resolves against. Defaults to the current time. */
    now?: Date;
    /** Data points `__interval` divides the range into. Defaults to 1000. */
    maxDataPoints?: number;
};

/**
 * A reserved (system-owned) parameter: the user-parameter shape plus a `resolve` that
 * computes its value from the query context, so it rides the existing parameter pipeline.
 */
export type ReservedParameterDefinition = LightdashProjectParameter & {
    resolve: (context: ReservedParameterContext) => ParameterValue;
};

/**
 * Resolves one reserved time parameter (CONTRACTS §2). Without a time range it resolves
 * to '', the same as `date_zoom` without a zoom.
 */
const resolveTimeParameter =
    (name: keyof ReservedTimeParameterValues) =>
    ({
        timeRange,
        refreshInterval,
        now,
        maxDataPoints,
    }: ReservedParameterContext): ParameterValue =>
        timeRange
            ? getReservedTimeParameterValues(timeRange, {
                  refreshInterval,
                  now,
                  maxDataPoints,
              })[name]
            : '';

/** Registry of reserved parameters. Add an entry here to expose a new system value. */
export const RESERVED_PARAMETERS: Record<string, ReservedParameterDefinition> =
    {
        date_zoom: {
            label: 'Date zoom',
            description:
                'The selected date zoom granularity in lowercase (e.g. "week"). Empty when no date zoom is selected.',
            type: 'string',
            resolve: ({ dateZoom }) =>
                dateZoom?.granularity
                    ? getGranularityReferenceValue(dateZoom.granularity)
                    : '',
        },
        __from: {
            label: 'Time range from',
            description:
                'Start of the dashboard time range as an ISO-8601 UTC timestamp. Relative ranges are rounded down to the refresh interval, or 10s. Empty when no time range applies.',
            type: 'string',
            resolve: resolveTimeParameter('__from'),
        },
        __to: {
            label: 'Time range to',
            description:
                'End of the dashboard time range as an ISO-8601 UTC timestamp. Relative ranges are rounded down to the refresh interval, or 10s. Empty when no time range applies.',
            type: 'string',
            resolve: resolveTimeParameter('__to'),
        },
        __interval: {
            label: 'Time range interval',
            description:
                'Step for the time range as a Prometheus duration (e.g. "30s"): the range over 1000 data points, rounded up to a nice step, at least 15s. Empty when no time range applies.',
            type: 'string',
            resolve: resolveTimeParameter('__interval'),
        },
        __range: {
            label: 'Time range duration',
            description:
                'Length of the time range as a Prometheus duration (e.g. "6h"). Empty when no time range applies.',
            type: 'string',
            resolve: resolveTimeParameter('__range'),
        },
    };

export const getReservedParameterNames = (): string[] =>
    Object.keys(RESERVED_PARAMETERS);

export const isReservedParameterName = (name: string): boolean =>
    name in RESERVED_PARAMETERS;

/**
 * Reserved parameter definitions in the shared definition shape (without resolvers), for
 * merging into the available-parameter map and rendering in the parameters UI.
 */
export const getReservedParameterDefinitions = (): ParameterDefinitions =>
    Object.entries(RESERVED_PARAMETERS).reduce<ParameterDefinitions>(
        (acc, [name, { resolve, ...definition }]) => ({
            ...acc,
            [name]: definition,
        }),
        {},
    );

/**
 * Resolve every reserved parameter to its value for the given query context. The clock is
 * read once, so every time parameter in one call sees the same `now`.
 */
export const resolveReservedParameterValues = (
    context: ReservedParameterContext,
): ParametersValuesMap => {
    const pinnedContext: ReservedParameterContext = {
        ...context,
        now: context.now ?? new Date(),
    };
    return Object.entries(RESERVED_PARAMETERS).reduce<ParametersValuesMap>(
        (acc, [name, { resolve }]) => ({
            ...acc,
            [name]: resolve(pinnedContext),
        }),
        {},
    );
};

/** Reserved names shadowed by a same-named user parameter (used to surface the override). */
export const getShadowedReservedNames = (
    userParameterNames: string[],
): string[] => {
    const userNames = new Set(userParameterNames);
    return getReservedParameterNames().filter((name) => userNames.has(name));
};

/** Append reserved names not already taken by a user parameter (deduped, user wins). */
export const mergeReservedNames = (userParameterNames: string[]): string[] => {
    const userNames = new Set(userParameterNames);
    return [
        ...userParameterNames,
        ...getReservedParameterNames().filter((name) => !userNames.has(name)),
    ];
};

/**
 * Merge reserved definitions under user definitions; a user definition of the same name
 * wins (shadows the reserved entry).
 */
export const mergeReservedDefinitions = (
    userDefinitions: ParameterDefinitions | undefined,
): ParameterDefinitions => ({
    ...getReservedParameterDefinitions(),
    ...(userDefinitions ?? {}),
});

/**
 * Merge resolved reserved values under user values; a user value of the same name wins
 * (shadows the reserved value).
 */
export const mergeReservedValues = (
    userValues: ParametersValuesMap | undefined,
    reservedValues: ParametersValuesMap,
): ParametersValuesMap => ({
    ...reservedValues,
    ...(userValues ?? {}),
});
