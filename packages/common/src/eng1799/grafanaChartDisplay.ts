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
 * - Legend: line and bar charts take the legend placement (bottom or right). They show the
 *   legend whenever there is more than one series, so a hidden legend is a warning.
 * - Stacking: normal stacking (timeseries `custom.stacking.mode`, barchart `options.stacking`,
 *   the legacy graph `stack` flag) stacks, and percent stacking (or the legacy graph
 *   `percentage` flag) stacks to 100%. Per-series stacking from overrides is a warning.
 * - Value mappings: SQL tables and pies show the raw values, so value mappings on them are
 *   warnings naming the option path.
 */
import { FilterOperator } from '../types/filter';
import { ChartKind } from '../types/savedCharts';
import type { CartesianChartDisplay } from '../visualizations/CartesianChartDataModel';
import type {
    VizBigNumberConditionalRule,
    VizBigNumberDisplay,
} from '../visualizations/types';
import { StackType } from '../visualizations/types';
import { resolveGrafanaColor } from './grafanaThresholds';
import type { ImportWarning } from './importWarnings';

type Warning = Pick<ImportWarning, 'code' | 'message' | 'path'>;

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
    /** Legacy graph panel stacking, legend and per-series overrides. */
    stack?: unknown;
    percentage?: unknown;
    legend?: unknown;
    seriesOverrides?: unknown;
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

type Legend = NonNullable<CartesianChartDisplay['legend']>;

/**
 * Where a line or bar panel puts its legend: Grafana places it at the bottom or on the right.
 * A hidden legend (`showLegend: false`, `displayMode: hidden`, legacy `legend.show: false`)
 * is a warning: SQL charts show the legend whenever there is more than one series.
 */
const cartesianLegend = (
    panel: GrafanaPanelForDisplay,
    panelType: string,
    warnings: Warning[],
): Legend | undefined => {
    const options = isRecord(panel.options) ? panel.options : {};
    const legend = isRecord(options.legend) ? options.legend : undefined;
    const legacy = isRecord(panel.legend) ? panel.legend : undefined;
    const hidden =
        legend?.showLegend === false ||
        legend?.displayMode === 'hidden' ||
        legacy?.show === false;
    if (hidden) {
        warnings.push({
            code: 'legend-unsupported',
            message: `The ${panelType} panel hides its legend, which SQL charts cannot do: they show the legend whenever there is more than one series`,
            path: legend ? 'options.legend' : 'legend',
        });
        return undefined;
    }
    const placement =
        legend?.placement ?? (legacy?.rightSide ? 'right' : undefined);
    if (placement === 'right') return { position: 'right', align: 'start' };
    if (placement === 'bottom') return { position: 'bottom', align: 'start' };
    return undefined;
};

const stackType = (mode: unknown): StackType | undefined => {
    if (mode === 'normal') return StackType.NORMAL;
    if (mode === 'percent') return StackType.PERCENT;
    return undefined;
};

/** Whether field overrides set stacking per series. */
const overridesStacking = (overrides: unknown): boolean =>
    (Array.isArray(overrides) ? overrides : [])
        .filter(isRecord)
        .some(
            (override) =>
                Array.isArray(override.properties) &&
                override.properties.some(
                    (property: unknown) =>
                        isRecord(property) && property.id === 'custom.stacking',
                ),
        );

/**
 * How a line or bar panel stacks: the timeseries field config, the barchart option or the
 * legacy graph flags. Stacking set per series (field overrides, legacy series overrides) is a
 * warning: SQL charts stack all series or none.
 */
const cartesianStack = (
    defaults: Record<string, unknown>,
    panel: GrafanaPanelForDisplay,
    panelType: string,
    warnings: Warning[],
): StackType | undefined => {
    const options = isRecord(panel.options) ? panel.options : {};
    const custom = isRecord(defaults.custom) ? defaults.custom : {};
    const stacking = isRecord(custom.stacking) ? custom.stacking : {};
    const seriesStacking =
        overridesStacking(panel.fieldConfig?.overrides) ||
        (Array.isArray(panel.seriesOverrides) &&
            panel.seriesOverrides.some(
                (override) => isRecord(override) && 'stack' in override,
            ));
    if (seriesStacking) {
        warnings.push({
            code: 'stacking-unsupported',
            message: `The ${panelType} panel stacks some series differently from the others, which SQL charts cannot do: they stack all series or none`,
        });
    }
    const fromOptions = stackType(options.stacking);
    if (fromOptions) return fromOptions;
    const fromField = stackType(stacking.mode);
    if (fromField) return fromField;
    if (panel.stack === true) {
        return panel.percentage === true ? StackType.PERCENT : StackType.NORMAL;
    }
    return undefined;
};

const hasMappings = (value: unknown) =>
    Array.isArray(value) && value.length > 0;

/** Whether any field override sets value mappings. */
const overridesMappings = (overrides: unknown): boolean =>
    (Array.isArray(overrides) ? overrides : [])
        .filter(isRecord)
        .some(
            (override) =>
                Array.isArray(override.properties) &&
                override.properties.some(
                    (property: unknown) =>
                        isRecord(property) &&
                        property.id === 'mappings' &&
                        hasMappings(property.value),
                ),
        );

/**
 * Value mappings on a table or pie: SQL tables and pies show the raw values. Each warning
 * carries the option path so the converter can skip paths it already reports as dropped.
 */
const valueMappingWarnings = (
    defaults: Record<string, unknown>,
    panel: GrafanaPanelForDisplay,
    panelType: string,
    kind: ChartKind,
): Warning[] => {
    const paths = [
        ...(hasMappings(defaults.mappings)
            ? ['fieldConfig.defaults.mappings']
            : []),
        ...(overridesMappings(panel.fieldConfig?.overrides)
            ? ['fieldConfig.overrides.mappings']
            : []),
    ];
    return paths.map((path) => ({
        code: 'option-dropped',
        message: `The ${panelType} panel option ${path} is not imported. ${kind === ChartKind.PIE ? 'SQL pie charts' : 'SQL tables'} show the raw values; they do not apply value mappings.`,
        path,
    }));
};

/**
 * The SQL chart display for a panel's unit, thresholds, legend, stacking and value mappings, and a warning for each the chart
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
        const legend = cartesianLegend(panel, panelType, warnings);
        const stack = cartesianStack(defaults, panel, panelType, warnings);
        const cartesian: CartesianChartDisplay = {
            ...(format ? { yAxis: [{ format }] } : {}),
            ...(legend ? { legend } : {}),
            ...(stack ? { stack } : {}),
        };
        return {
            ...(Object.keys(cartesian).length > 0 ? { cartesian } : {}),
            warnings,
        };
    }
    if (kind === ChartKind.TABLE || kind === ChartKind.PIE) {
        warnings.push(
            ...valueMappingWarnings(defaults, panel, panelType, kind),
        );
    }
    return { warnings };
};
