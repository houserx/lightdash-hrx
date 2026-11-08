import {
    buildCloudWatchMetricDataQuery,
    type CloudWatchMetricDataQuery,
} from '@lightdash/common';

/** The CloudWatch metric form as the user typed it. */
export type CloudWatchFormValues = {
    namespace: string;
    metricName: string;
    /** `Name=Value` pairs separated by commas or new lines. */
    dimensions: string;
    stat: string;
    /** Seconds, as typed. */
    period: string;
};

export const DEFAULT_CLOUDWATCH_FORM: CloudWatchFormValues = {
    namespace: '',
    metricName: '',
    dimensions: '',
    stat: 'Average',
    period: '300',
};

/** Parses `Name=Value` pairs; undefined when a pair is incomplete. */
const parseDimensions = (text: string): Record<string, string> | undefined => {
    const dimensions: Record<string, string> = {};
    const pairs = text
        .split(/[,\n]/)
        .map((pair) => pair.trim())
        .filter((pair) => pair !== '');
    for (const pair of pairs) {
        const separator = pair.indexOf('=');
        if (separator <= 0) return undefined;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (name === '' || value === '') return undefined;
        dimensions[name] = value;
    }
    return dimensions;
};

/**
 * The MetricDataQuery JSON (indented) for a filled-in form, or undefined while the form is
 * incomplete or invalid.
 */
export const metricDataQueryJsonFromForm = (
    form: CloudWatchFormValues,
): string | undefined => {
    const dimensions = parseDimensions(form.dimensions);
    const period = Number(form.period.trim());
    if (dimensions === undefined || form.period.trim() === '') return undefined;
    try {
        return JSON.stringify(
            buildCloudWatchMetricDataQuery({
                namespace: form.namespace,
                metricName: form.metricName,
                dimensions,
                stat: form.stat,
                period,
            }),
            null,
            2,
        );
    } catch {
        return undefined;
    }
};

/**
 * Parses MetricDataQuery JSON typed by hand: an object with an Id and either a MetricStat or
 * an Expression (metric math or SEARCH).
 */
export const parseMetricDataQuery = (
    json: string,
): { query: CloudWatchMetricDataQuery } | { error: string } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { error: 'Not valid JSON' };
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        return { error: 'The MetricDataQuery must be a JSON object' };
    }
    const query = parsed as Record<string, unknown>;
    if (typeof query.Id !== 'string' || query.Id.trim() === '') {
        return { error: 'The MetricDataQuery needs an Id' };
    }
    const hasMetricStat =
        typeof query.MetricStat === 'object' && query.MetricStat !== null;
    const hasExpression =
        typeof query.Expression === 'string' && query.Expression.trim() !== '';
    if (!hasMetricStat && !hasExpression) {
        return {
            error: 'The MetricDataQuery needs a MetricStat or an Expression',
        };
    }
    return { query: parsed as CloudWatchMetricDataQuery };
};

/** Splits the comma-separated log groups field. */
export const splitLogGroups = (logGroups: string): string[] =>
    logGroups
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
