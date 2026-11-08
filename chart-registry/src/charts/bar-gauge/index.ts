import { formatGrafanaText } from '../../shared/grafanaFormat';
import { parseThresholds, thresholdColor } from '../../shared/thresholds';
import {
    onVizContext,
    rawValue,
    toNumber,
    type VizContext,
} from '../../shared/vizContext';
import {
    buildBars,
    displayModeOption,
    gradientStops,
    linearGradientCss,
    orientationOption,
    type DisplayMode,
    type GaugeBar,
    type Orientation,
} from './barGauge';

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;

/** The `decimals` option: a whole number from 0 to 20, else automatic (null). */
const decimalsOption = (raw: unknown): number | null => {
    const value = toNumber(raw);
    if (value === null || value < 0) return null;
    return Math.min(Math.round(value), 20);
};

/** A row's name cell as text (blank when empty). */
const nameText = (raw: unknown): string =>
    raw === null || raw === undefined ? '' : String(raw);

const element = (
    tag: string,
    testId: string | null,
    css: string,
    text?: string,
): HTMLElement => {
    const el = document.createElement(tag);
    if (testId) el.setAttribute('data-testid', testId);
    el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
};

/**
 * How a bar is painted: its threshold colour (also the value text's colour)
 * and the CSS background of the filled bar, solid in basic mode or a
 * gradient through the threshold colours in gradient mode.
 */
type BarPaint = { color: string; background: string };

/**
 * One gauge: the name, a track with the bar filled to its share, and the
 * formatted value. Horizontal gauges stack as rows (name above, value at
 * the right of the track); vertical gauges sit side by side as columns
 * (value above, name below, the bar growing up from the bottom).
 */
const gauge = (
    bar: GaugeBar,
    text: string,
    orientation: Orientation,
    mode: DisplayMode,
    paint: BarPaint,
): HTMLElement => {
    const horizontal = orientation === 'horizontal';
    const row = element(
        'div',
        'bar-gauge-row',
        horizontal
            ? 'display:flex;flex-direction:column;flex:1 1 0;min-height:0;max-height:64px;gap:2px'
            : 'display:flex;flex-direction:column;align-items:stretch;flex:1 1 0;min-width:0;' +
                  'max-width:120px;gap:4px',
    );
    row.setAttribute('data-name', bar.name);

    const name = element(
        'div',
        'bar-gauge-name',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
            (horizontal ? '' : 'text-align:center;order:3'),
        bar.name,
    );
    name.title = bar.name;

    const value = element(
        'div',
        'bar-gauge-value',
        `color:${paint.color};font-weight:500;font-size:14px;white-space:nowrap;` +
            'font-variant-numeric:tabular-nums;' +
            (horizontal
                ? 'flex:none;min-width:56px;text-align:right'
                : 'text-align:center;order:1'),
        text,
    );

    const track = element(
        'div',
        'bar-gauge-track',
        'position:relative;flex:1 1 0;background:rgba(128,128,128,0.15);border-radius:2px;' +
            (horizontal ? 'min-width:0;height:100%' : 'min-height:0;order:2'),
    );
    const percent = `${Math.round(bar.fill * 10000) / 100}%`;
    // Set as the attribute, not through the style object, so the gradient
    // reaches the page exactly as written.
    const fill = element('div', 'bar-gauge-bar', '');
    fill.setAttribute(
        'style',
        `position:absolute;left:0;bottom:0;background:${paint.background};border-radius:2px;` +
            (horizontal
                ? `top:0;width:${percent}`
                : `right:0;height:${percent}`),
    );
    fill.setAttribute('data-name', bar.name);
    fill.setAttribute('data-fill', String(bar.fill));
    fill.setAttribute('data-mode', mode);
    fill.setAttribute('data-color', paint.color);
    if (bar.value !== null) fill.setAttribute('data-value', String(bar.value));
    fill.title = `${bar.name}: ${text}`;
    track.appendChild(fill);

    if (horizontal) {
        const line = element(
            'div',
            null,
            'display:flex;align-items:center;gap:8px;flex:1 1 0;min-height:8px',
        );
        line.append(track, value);
        row.append(name, line);
    } else {
        row.append(value, track, name);
    }
    return row;
};

const render = (root: HTMLElement, context: VizContext): void => {
    root.textContent = '';
    const options = context.options ?? {};
    const orientation = orientationOption(options.orientation);
    const mode = displayModeOption(options.displayMode);
    const min = toNumber(options.min) ?? DEFAULT_MIN;
    const max = toNumber(options.max) ?? DEFAULT_MAX;
    const unit = typeof options.unit === 'string' ? options.unit : '';
    const decimals = decimalsOption(options.decimals);
    const thresholds = parseThresholds(options.thresholds);
    const range = { min, max };
    const colorAt = (value: number): string =>
        thresholdColor(value, thresholds, range);
    const paintOf = (bar: GaugeBar): BarPaint => {
        // An empty cell takes the base colour (its bar is empty anyway).
        const value = bar.value ?? -Infinity;
        const color = colorAt(value);
        if (mode === 'basic' || bar.value === null) {
            return { color, background: color };
        }
        const stops = gradientStops(bar.value, thresholds, range, colorAt);
        return {
            color,
            background: linearGradientCss(
                stops,
                orientation === 'horizontal' ? 'to right' : 'to top',
            ),
        };
    };

    const bars = buildBars(
        context.rows.map((row) => ({
            name: nameText(rawValue(context, row, 'name')),
            value: toNumber(rawValue(context, row, 'value')),
        })),
        min,
        max,
    );

    const panel = element(
        'div',
        'bar-gauge',
        'display:flex;box-sizing:border-box;height:100%;padding:8px;' +
            (orientation === 'horizontal'
                ? 'flex-direction:column;justify-content:center;gap:8px'
                : 'flex-direction:row;justify-content:center;gap:12px'),
    );
    panel.setAttribute('data-orientation', orientation);
    panel.setAttribute('data-min', String(min));
    panel.setAttribute('data-max', String(max));

    if (bars.length === 0) {
        const empty = element('div', 'bar-gauge-empty', '', 'No data');
        empty.className = 'empty';
        panel.appendChild(empty);
    }
    for (const bar of bars) {
        const text =
            bar.value === null
                ? '-'
                : formatGrafanaText(bar.value, unit, decimals);
        panel.appendChild(gauge(bar, text, orientation, mode, paintOf(bar)));
    }
    root.appendChild(panel);
};

const root = document.getElementById('root') ?? document.body;
onVizContext((context) => render(root, context));
