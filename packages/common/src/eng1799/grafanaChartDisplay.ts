import { Format } from '../types/field';
/**
 * ENG-1799 importers: a Grafana panel's unit and thresholds on the SQL chart it becomes, as far
 * as the SQL chart kind can show them. What it can't show is a warning, never dropped silently.
 *
 * - Units: line and bar charts take a Lightdash `Format` on the y axis. Only units with the same
 *   meaning map: `percentunit` (0-1, shown as 0.9 -> 90%) is the percent format, and the
 *   currency units are their currency formats. Grafana's `percent` (0-100) is not the percent
 *   format, which would show 90 as 9000%. Big numbers, pies and tables have no format setting.
 * - Thresholds: a big number gets one conditional formatting rule per threshold step after the
 *   base step (`greaterThanOrEqual` the step value, highest first, since the first matching rule
 *   wins). The base step's colour has no rule: values below the first step keep the default
 *   colour. Line and bar charts have no threshold lines or bands.
 */
import { FilterOperator } from '../types/filter';
import { ChartKind } from '../types/savedCharts';
import type { CartesianChartDisplay } from '../visualizations/CartesianChartDataModel';
import type {
    VizBigNumberConditionalRule,
    VizBigNumberDisplay,
} from '../visualizations/types';
import { resolveGrafanaColor } from './grafanaThresholds';
import type { ImportWarning } from './importWarnings';

type Warning = Pick<ImportWarning, 'code' | 'message'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Grafana units a SQL chart `Format` shows the same way. */
const GRAFANA_UNIT_SQL_FORMATS: Record<string, Format> = {
    percentunit: Format.PERCENT,
    currencyUSD: Format.USD,
    currencyGBP: Format.GBP,
    currencyEUR: Format.EUR,
    currencyJPY: Format.JPY,
    currencyDKK: Format.DKK,
};

const hex2 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0');

/**
 * A Grafana colour as `#rrggbb`: palette names, `#rgb`, `#rrggbb`, `#rrggbbaa` and
 * `rgb()`/`rgba()` (alpha dropped). Undefined for anything else (`text`, `transparent`).
 */
export const grafanaColorToHex = (color: unknown): string | undefined => {
    if (typeof color !== 'string') return undefined;
    const resolved = resolveGrafanaColor(color).trim().toLowerCase();
    const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(resolved);
    if (long) return `#${long[1]}`;
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(resolved);
    if (short)
        return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    const rgb =
        /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*[\d.]+%?\s*)?\)$/.exec(
            resolved,
        );
    if (rgb) {
        return `#${hex2(Number(rgb[1]))}${hex2(Number(rgb[2]))}${hex2(Number(rgb[3]))}`;
    }
    return undefined;
};

type ThresholdStep = { value: number | null; color: unknown };

const thresholdSteps = (thresholds: unknown): ThresholdStep[] =>
    (isRecord(thresholds) && Array.isArray(thresholds.steps)
        ? thresholds.steps
        : []
    )
        .filter(isRecord)
        .map((step) => ({
            value:
                typeof step.value === 'number' && Number.isFinite(step.value)
                    ? step.value
                    : null,
            color: step.color,
        }));

/** The steps after the base step: the ones that start at a value. */
const valueSteps = (thresholds: unknown) =>
    thresholdSteps(thresholds).filter(
        (step): step is { value: number; color: unknown } =>
            step.value !== null,
    );

export type GrafanaPanelForDisplay = {
    type?: string;
    options?: Record<string, unknown>;
    fieldConfig?: { defaults?: unknown; overrides?: unknown };
    /** Legacy graph panel thresholds. */
    thresholds?: unknown;
};

export type GrafanaChartDisplay = {
    /** The line or bar chart display; undefined for other kinds or nothing to show. */
    cartesian?: CartesianChartDisplay;
    /** The big number display; undefined for other kinds or nothing to show. */
    bigNumber?: VizBigNumberDisplay;
    warnings: Warning[];
};

const unitDisplay = (
    unit: string | undefined,
    kind: ChartKind,
    panelType: string,
    warnings: Warning[],
): Format | undefined => {
    if (!unit || unit === 'none') return undefined;
    const cartesian =
        kind === ChartKind.LINE || kind === ChartKind.VERTICAL_BAR;
    const format = Object.prototype.hasOwnProperty.call(
        GRAFANA_UNIT_SQL_FORMATS,
        unit,
    )
        ? GRAFANA_UNIT_SQL_FORMATS[unit]
        : undefined;
    if (cartesian && format) return format;
    warnings.push({
        code: 'unit-unsupported',
        message: cartesian
            ? `The ${panelType} panel unit ${unit} has no ${kind} SQL chart format, so values are shown as plain numbers`
            : `The ${panelType} panel unit ${unit} is not imported: ${kind} SQL charts have no number format, so values are shown as plain numbers`,
    });
    return undefined;
};

const bigNumberRules = (
    defaults: Record<string, unknown>,
    panel: GrafanaPanelForDisplay,
    panelType: string,
    warnings: Warning[],
): VizBigNumberConditionalRule[] => {
    const options = isRecord(panel.options) ? panel.options : {};
    // Grafana colours nothing by thresholds with colorMode none.
    if (options.colorMode === 'none') return [];
    const steps = valueSteps(defaults.thresholds);
    if (steps.length === 0) return [];
    const thresholds = isRecord(defaults.thresholds) ? defaults.thresholds : {};
    if (thresholds.mode === 'percentage') {
        warnings.push({
            code: 'thresholds-unsupported',
            message: `The ${panelType} panel thresholds are percentages of the min..max range, which big number conditional formatting cannot express; they are not imported`,
        });
        return [];
    }
    return [...steps]
        .sort((a, b) => b.value - a.value)
        .flatMap((step) => {
            const color = grafanaColorToHex(step.color);
            if (!color) {
                warnings.push({
                    code: 'thresholds-unsupported',
                    message: `The ${panelType} panel threshold at ${step.value} has the colour ${String(step.color)}, which has no hex value; its conditional formatting rule is not imported`,
                });
                return [];
            }
            return [
                {
                    operator: FilterOperator.GREATER_THAN_OR_EQUAL,
                    value: step.value,
                    color,
                },
            ];
        });
};

/** Whether a line or bar panel draws threshold lines or bands. */
const drawsThresholds = (
    defaults: Record<string, unknown>,
    panel: GrafanaPanelForDisplay,
): boolean => {
    if (Array.isArray(panel.thresholds) && panel.thresholds.length > 0) {
        return true;
    }
    const custom = isRecord(defaults.custom) ? defaults.custom : {};
    const style = isRecord(custom.thresholdsStyle)
        ? custom.thresholdsStyle.mode
        : undefined;
    return (
        typeof style === 'string' &&
        style !== 'off' &&
        valueSteps(defaults.thresholds).length > 0
    );
};

/** Whether any field override sets a unit (per-series units). */
const overridesUnit = (overrides: unknown): boolean =>
    (Array.isArray(overrides) ? overrides : [])
        .filter(isRecord)
        .some(
            (override) =>
                Array.isArray(override.properties) &&
                override.properties.some(
                    (property: unknown) =>
                        isRecord(property) && property.id === 'unit',
                ),
        );

/**
 * The SQL chart display for a panel's unit and thresholds, and a warning for each the chart
 * kind can't show.
 */
export const grafanaChartDisplay = (
    panel: GrafanaPanelForDisplay,
    kind: ChartKind,
): GrafanaChartDisplay => {
    const warnings: Warning[] = [];
    const panelType = panel.type ?? 'panel';
    const defaults = isRecord(panel.fieldConfig?.defaults)
        ? panel.fieldConfig.defaults
        : {};
    const unit =
        typeof defaults.unit === 'string' && defaults.unit.trim()
            ? defaults.unit.trim()
            : undefined;
    const format = unitDisplay(unit, kind, panelType, warnings);
    if (overridesUnit(panel.fieldConfig?.overrides)) {
        warnings.push({
            code: 'unit-unsupported',
            message: `The ${panelType} panel sets units per field in overrides, which SQL charts cannot show; they are not imported`,
        });
    }

    if (kind === ChartKind.BIG_NUMBER) {
        const rules = bigNumberRules(defaults, panel, panelType, warnings);
        return {
            ...(rules.length > 0
                ? { bigNumber: { conditionalFormatting: rules } }
                : {}),
            warnings,
        };
    }
    if (kind === ChartKind.LINE || kind === ChartKind.VERTICAL_BAR) {
        if (drawsThresholds(defaults, panel)) {
            warnings.push({
                code: 'thresholds-unsupported',
                message: `The ${panelType} panel draws threshold lines or bands, which ${kind} SQL charts cannot show; they are not imported`,
            });
        }
        return {
            ...(format ? { cartesian: { yAxis: [{ format }] } } : {}),
            warnings,
        };
    }
    return { warnings };
};
