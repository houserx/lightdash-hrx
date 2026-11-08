/**
 * Grafana value mappings for registry entries. The `valueMappings` config
 * option is a text option holding Grafana's own mappings JSON (a panel's
 * `fieldConfig.defaults.mappings` array), so the importer can copy it
 * verbatim. Matching is @lightdash/common's `applyValueMappings`, bundled
 * from its source file (not the package index, which would pull the whole
 * common import graph into the entry's script).
 */
import {
    applyValueMappings,
    type GrafanaMappableValue,
    type GrafanaValueMapping,
    type GrafanaValueMappingResult,
} from '../../../packages/common/src/eng1799/grafanaValueMappings';

const MAPPING_TYPES = new Set(['value', 'range', 'regex', 'special']);

const isMapping = (item: unknown): item is GrafanaValueMapping =>
    typeof item === 'object' &&
    item !== null &&
    MAPPING_TYPES.has((item as { type?: unknown }).type as string) &&
    typeof (item as { options?: unknown }).options === 'object' &&
    (item as { options?: unknown }).options !== null;

/**
 * Reads a `valueMappings` option: Grafana's mappings array as JSON text (an
 * already-parsed array is accepted too). Blank, malformed or non-array
 * values give no mappings; entries that are not mappings are dropped.
 */
export const parseValueMappings = (option: unknown): GrafanaValueMapping[] => {
    let value = option;
    if (typeof value === 'string') {
        if (value.trim() === '') return [];
        try {
            value = JSON.parse(value);
        } catch {
            return [];
        }
    }
    return Array.isArray(value) ? value.filter(isMapping) : [];
};

/** The mapping result for a raw cell value, or undefined when none matches. */
export const mapValue = (
    raw: unknown,
    mappings: readonly GrafanaValueMapping[],
): GrafanaValueMappingResult | undefined => {
    if (mappings.length === 0) return undefined;
    const value: GrafanaMappableValue =
        typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'boolean' ||
        raw === null ||
        raw === undefined
            ? raw
            : String(raw);
    return applyValueMappings(value, mappings);
};
