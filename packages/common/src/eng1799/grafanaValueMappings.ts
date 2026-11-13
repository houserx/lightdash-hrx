import { resolveGrafanaColor } from './grafanaThresholds';

/**
 * Grafana value mappings, as stored in a panel's
 * `fieldConfig.defaults.mappings`. Each result carries an `index`: the row
 * order in Grafana's mapping editor, which is the order mappings are tried.
 */
export type GrafanaValueMappingResult = {
    text?: string;
    color?: string;
    icon?: string;
    index?: number;
};

export type GrafanaValueToTextMapping = {
    type: 'value';
    options: Record<string, GrafanaValueMappingResult>;
};

export type GrafanaRangeToTextMapping = {
    type: 'range';
    options: {
        /** Inclusive lower bound; null or missing means open. */
        from?: number | null;
        /** Inclusive upper bound; null or missing means open. */
        to?: number | null;
        result: GrafanaValueMappingResult;
    };
};

export type GrafanaRegexToTextMapping = {
    type: 'regex';
    options: {
        pattern: string;
        result: GrafanaValueMappingResult;
    };
};

export type GrafanaSpecialValueMatch =
    | 'null'
    | 'nan'
    | 'null+nan'
    | 'true'
    | 'false'
    | 'empty';

export type GrafanaSpecialValueMapping = {
    type: 'special';
    options: {
        match: GrafanaSpecialValueMatch;
        result: GrafanaValueMappingResult;
    };
};

export type GrafanaValueMapping =
    | GrafanaValueToTextMapping
    | GrafanaRangeToTextMapping
    | GrafanaRegexToTextMapping
    | GrafanaSpecialValueMapping;

export type GrafanaMappableValue = string | number | boolean | null | undefined;

/**
 * Grafana's `stringToJsRegex`: `/pattern/flags` is used as written, a bare
 * pattern must match the whole value.
 */
const toRegex = (pattern: string): RegExp | undefined => {
    try {
        if (!pattern.startsWith('/')) return new RegExp(`^${pattern}$`);
        const literal = pattern.match(/^\/(.*?)\/(g?i?m?y?s?)$/);
        return literal ? new RegExp(literal[1], literal[2]) : undefined;
    } catch {
        return undefined;
    }
};

const isNaNValue = (value: GrafanaMappableValue): boolean =>
    typeof value === 'number' && Number.isNaN(value);

const toNumber = (value: GrafanaMappableValue): number => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseFloat(value);
    return Number.NaN;
};

const matchesSpecial = (
    match: GrafanaSpecialValueMatch,
    value: GrafanaMappableValue,
): boolean => {
    switch (match) {
        case 'null':
            return value === null || value === undefined;
        case 'nan':
            return isNaNValue(value);
        case 'null+nan':
            return value === null || value === undefined || isNaNValue(value);
        case 'true':
            return value === true || value === 'true';
        case 'false':
            return value === false || value === 'false';
        case 'empty':
            return value === '';
        default:
            return false;
    }
};

/** The result one mapping gives for a value, or undefined if it misses. */
const matchMapping = (
    mapping: GrafanaValueMapping,
    value: GrafanaMappableValue,
): GrafanaValueMappingResult | undefined => {
    switch (mapping.type) {
        case 'value':
            if (value === null || value === undefined) return undefined;
            return Object.prototype.hasOwnProperty.call(
                mapping.options,
                String(value),
            )
                ? mapping.options[String(value)]
                : undefined;
        case 'range': {
            const n = toNumber(value);
            if (Number.isNaN(n)) return undefined;
            const { from, to, result } = mapping.options;
            if (typeof from === 'number' && n < from) return undefined;
            if (typeof to === 'number' && n > to) return undefined;
            return result;
        }
        case 'regex': {
            if (typeof value !== 'string') return undefined;
            const regex = toRegex(mapping.options.pattern);
            if (!regex || !value.match(regex)) return undefined;
            const { result } = mapping.options;
            // Grafana substitutes the text into the match, so $1 etc. work.
            return result.text === undefined
                ? result
                : { ...result, text: value.replace(regex, result.text) };
        }
        case 'special':
            return matchesSpecial(mapping.options.match, value)
                ? mapping.options.result
                : undefined;
        default:
            return undefined;
    }
};

/**
 * Applies Grafana value mappings to a value. Mappings are tried in the
 * order of their result `index` (the editor's row order; results without
 * an index come after, in array order) and the first match wins. The
 * returned colour is resolved from Grafana palette names to hex. Returns
 * undefined when nothing matches.
 */
export const applyValueMappings = (
    value: GrafanaMappableValue,
    mappings: readonly GrafanaValueMapping[],
): GrafanaValueMappingResult | undefined => {
    let best: { result: GrafanaValueMappingResult; order: number } | undefined;
    mappings.forEach((mapping) => {
        const result = matchMapping(mapping, value);
        if (!result) return;
        const order = result.index ?? Number.POSITIVE_INFINITY;
        if (!best || order < best.order) best = { result, order };
    });
    if (!best) return undefined;
    const { result } = best;
    return result.color === undefined
        ? { ...result }
        : { ...result, color: resolveGrafanaColor(result.color) };
};
