import { formatGrafanaValue } from '../../shared/grafanaFormat';
import { parseThresholds, thresholdColor } from '../../shared/thresholds';
import {
    onVizContext,
    rawValue,
    toNumber,
    type VizContext,
} from '../../shared/vizContext';
import {
    DEFAULT_REDUCER,
    isReducer,
    orderPoints,
    reduce,
    type StatPoint,
} from './stat';

/** A time cell as epoch millis: dates, epoch millis (numbers or digits) and date strings. */
const toMillis = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    let millis: number;
    if (raw instanceof Date) millis = raw.getTime();
    else if (typeof raw === 'number') millis = raw;
    else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        millis = Number(raw);
    } else millis = Date.parse(String(raw));
    return Number.isFinite(millis) ? millis : null;
};

/** The `decimals` option: a whole number from 0 to 20, else automatic (null). */
const decimalsOption = (raw: unknown): number | null => {
    const value = toNumber(raw);
    if (value === null || value < 0) return null;
    return Math.min(Math.round(value), 20);
};

const COLOR_MODES = ['value', 'background', 'none'] as const;
type ColorMode = (typeof COLOR_MODES)[number];

const colorModeOption = (raw: unknown): ColorMode =>
    COLOR_MODES.find((mode) => mode === raw) ?? 'value';

/**
 * Text colour readable on a background: near-black on light colours, white
 * on dark ones (relative luminance of a #RRGGBB colour; white otherwise).
 */
const textOn = (background: string): string => {
    const hex = /^#([0-9a-f]{6})$/i.exec(background.trim());
    if (!hex) return '#FFFFFF';
    const channel = (offset: number): number => {
        const c = parseInt(hex[1].slice(offset, offset + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
        0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    return luminance > 0.5 ? '#202226' : '#FFFFFF';
};

/**
 * The range percentage threshold steps are read against: the min..max of
 * the series (Grafana uses the field's data range when no min/max is set),
 * or Grafana's default 0..100 when the series has no spread.
 */
const dataRange = (
    values: readonly (number | null)[],
): { min: number; max: number } | undefined => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (v === null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return min < max ? { min, max } : undefined;
};

const render = (root: HTMLElement, context: VizContext): void => {
    root.textContent = '';
    const options = context.options ?? {};
    const reducer = isReducer(options.reducer)
        ? options.reducer
        : DEFAULT_REDUCER;
    const unit = typeof options.unit === 'string' ? options.unit : '';
    const decimals = decimalsOption(options.decimals);
    const colorMode = colorModeOption(options.colorMode);
    const thresholds = parseThresholds(options.thresholds);

    const points: StatPoint[] = orderPoints(
        context.rows.map((row) => ({
            time: toMillis(rawValue(context, row, 'time')),
            value: toNumber(rawValue(context, row, 'value')),
        })),
    );
    const value = reduce(
        points.map((p) => p.value),
        reducer,
    );

    const stat = document.createElement('div');
    stat.setAttribute('data-testid', 'stat');
    stat.setAttribute('data-reducer', reducer);
    stat.setAttribute('data-color-mode', colorMode);
    stat.style.cssText =
        'display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;height:100%;box-sizing:border-box;padding:8px';

    const valueEl = document.createElement('div');
    valueEl.setAttribute('data-testid', 'stat-value');
    // Big enough to read, small enough to fit the tile.
    const size = Math.max(
        14,
        Math.min(root.clientHeight * 0.4, root.clientWidth / 6, 64),
    );
    valueEl.style.cssText =
        `font-size:${Math.round(size)}px;font-weight:500;line-height:1.1;` +
        'white-space:nowrap;font-variant-numeric:tabular-nums';

    if (value === null) {
        valueEl.textContent = 'No data';
        valueEl.style.opacity = '0.6';
        stat.setAttribute('data-empty', 'true');
    } else {
        const parts = formatGrafanaValue(value, unit, decimals);
        stat.setAttribute('data-value', String(value));
        valueEl.append(parts.prefix, parts.text);
        const color = thresholdColor(
            value,
            thresholds,
            dataRange(points.map((p) => p.value)),
        );
        if (colorMode === 'value') {
            stat.setAttribute('data-color', color);
            valueEl.style.color = color;
        } else if (colorMode === 'background') {
            stat.setAttribute('data-color', color);
            stat.style.background = color;
            stat.style.color = textOn(color);
        }
        if (parts.suffix) {
            // Grafana draws the unit a little smaller than the number.
            const suffix = document.createElement('span');
            suffix.setAttribute('data-testid', 'stat-unit');
            suffix.style.fontSize = '0.7em';
            suffix.textContent = parts.suffix;
            valueEl.appendChild(suffix);
        }
    }
    stat.appendChild(valueEl);

    const label = context.fields?.value?.label;
    if (label) {
        const title = document.createElement('div');
        title.setAttribute('data-testid', 'stat-label');
        title.style.cssText = 'opacity:0.7;margin-top:4px';
        title.textContent = label;
        stat.appendChild(title);
    }
    root.appendChild(stat);
};

const root = document.getElementById('root') ?? document.body;
onVizContext((context) => render(root, context));
