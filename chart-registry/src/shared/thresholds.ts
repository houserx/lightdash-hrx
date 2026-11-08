/**
 * Grafana threshold steps for registry entries. The `thresholds` config
 * option is a text option holding Grafana's own thresholds JSON (a panel's
 * `fieldConfig.defaults.thresholds` object, or just its `steps` array), so
 * the importer can copy it verbatim. Colour lookup is @lightdash/common's
 * `getThresholdColor`, bundled from its source file (not the package index,
 * which would pull the whole common import graph into the entry's script).
 */
import {
    getThresholdColor,
    type GrafanaThresholdRange,
    type GrafanaThresholds,
    type GrafanaThresholdStep,
} from '../../../packages/common/src/eng1799/grafanaThresholds';

const toStep = (item: unknown): GrafanaThresholdStep | undefined => {
    if (typeof item !== 'object' || item === null) return undefined;
    const { value, color } = item as { value?: unknown; color?: unknown };
    if (typeof color !== 'string' || color.trim() === '') return undefined;
    // Grafana stores the base step's -Infinity as null in JSON.
    if (value === null || value === undefined) return { value: null, color };
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (typeof numeric !== 'number' || Number.isNaN(numeric)) return undefined;
    return {
        value: Number.isFinite(numeric) ? numeric : null,
        color,
    };
};

/**
 * Reads a `thresholds` option: Grafana's `{ mode, steps }` object or a bare
 * steps array, as JSON text (already-parsed values are accepted too).
 * Blank, malformed or step-less values give undefined (no thresholds);
 * steps without a colour or a numeric value are dropped.
 */
export const parseThresholds = (
    option: unknown,
): GrafanaThresholds | undefined => {
    let value = option;
    if (typeof value === 'string') {
        if (value.trim() === '') return undefined;
        try {
            value = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    let mode: GrafanaThresholds['mode'] = 'absolute';
    let rawSteps: unknown = value;
    if (!Array.isArray(value)) {
        if (typeof value !== 'object' || value === null) return undefined;
        const object = value as { mode?: unknown; steps?: unknown };
        if (object.mode === 'percentage') mode = 'percentage';
        rawSteps = object.steps;
    }
    if (!Array.isArray(rawSteps)) return undefined;
    const steps = rawSteps
        .map(toStep)
        .filter((step): step is GrafanaThresholdStep => step !== undefined);
    return steps.length > 0 ? { mode, steps } : undefined;
};

/**
 * The colour of a value under the given thresholds (Grafana's base green
 * when none are set). Percentage steps are read against `range`.
 */
export const thresholdColor = (
    value: number,
    thresholds: GrafanaThresholds | undefined,
    range?: GrafanaThresholdRange,
): string =>
    getThresholdColor(
        value,
        thresholds ?? { mode: 'absolute', steps: [] },
        range,
    );
