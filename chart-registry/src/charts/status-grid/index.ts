import { formatGrafanaText } from '../../shared/grafanaFormat';
import { parseThresholds, thresholdColor } from '../../shared/thresholds';
import { mapValue, parseValueMappings } from '../../shared/valueMappings';
import {
    onVizContext,
    rawValue,
    toNumber,
    type VizContext,
} from '../../shared/vizContext';
import { buildStatusGrid, columnsOption } from './statusGrid';

const DEFAULT_COLUMNS = 4;
// Grafana's "no value" grey, for cells with nothing to colour them by.
const NO_VALUE_COLOR = '#8E8E8E';
const HEX = /^#[0-9a-f]{6}$/i;

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

const seriesText = (raw: unknown): string | null =>
    raw === null || raw === undefined || String(raw).trim() === ''
        ? null
        : String(raw).trim();

/** The `decimals` option: a whole number from 0 to 20, else automatic (null). */
const decimalsOption = (raw: unknown): number | null => {
    const value = toNumber(raw);
    if (value === null || value < 0) return null;
    return Math.min(Math.round(value), 20);
};

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
 * the cells' values (Grafana uses the field's data range when no min/max
 * is set), or Grafana's default 0..100 when they have no spread.
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
    const thresholds = parseThresholds(options.thresholds);
    const mappings = parseValueMappings(options.valueMappings);
    const columns = columnsOption(options.columns, DEFAULT_COLUMNS);
    const unit = typeof options.unit === 'string' ? options.unit : '';
    const decimals = decimalsOption(options.decimals);

    const cells = buildStatusGrid(
        context.rows.map((row) => ({
            time: toMillis(rawValue(context, row, 'time')),
            series: seriesText(rawValue(context, row, 'series')),
            value: rawValue(context, row, 'value'),
        })),
    );

    if (cells.length === 0) {
        const empty = document.createElement('div');
        empty.setAttribute('data-testid', 'status-grid-empty');
        empty.className = 'empty';
        empty.textContent = 'No data';
        root.appendChild(empty);
        return;
    }

    const range = dataRange(cells.map((c) => toNumber(c.value)));
    const rowCount = Math.ceil(cells.length / columns);

    const grid = document.createElement('div');
    grid.setAttribute('data-testid', 'status-grid');
    grid.setAttribute('data-columns', String(columns));
    grid.setAttribute('role', 'list');
    grid.style.cssText =
        'display:grid;gap:4px;height:100%;box-sizing:border-box;padding:4px;' +
        `grid-template-columns:repeat(${columns},minmax(0,1fr));` +
        `grid-template-rows:repeat(${rowCount},minmax(0,1fr))`;

    const size = Math.max(
        11,
        Math.min(
            (root.clientHeight || 150) / rowCount / 4,
            (root.clientWidth || 300) / columns / 6,
            32,
        ),
    );

    for (const cell of cells) {
        const number = toNumber(cell.value);
        // A value mapping's text and colour win; otherwise the number is
        // formatted with the unit and coloured by the thresholds. Text that
        // no mapping matches is shown as it is, in the no-value grey.
        const mapped = mapValue(cell.value, mappings);
        let text: string;
        if (mapped?.text !== undefined) text = mapped.text;
        else if (number !== null)
            text = formatGrafanaText(number, unit, decimals);
        else if (cell.value === null) text = 'No data';
        else text = String(cell.value).trim();
        const rawColor =
            mapped?.color?.trim() ||
            (number !== null
                ? thresholdColor(number, thresholds, range)
                : NO_VALUE_COLOR);
        const color = HEX.test(rawColor) ? rawColor.toUpperCase() : rawColor;

        const element = document.createElement('div');
        element.setAttribute('data-testid', 'status-grid-cell');
        element.setAttribute('data-series', cell.series);
        element.setAttribute('data-color', color);
        element.setAttribute('data-text', text);
        element.setAttribute('role', 'listitem');
        if (cell.value === null) element.setAttribute('data-empty', 'true');
        else element.setAttribute('data-value', String(cell.value));
        if (mapped) element.setAttribute('data-mapped', 'true');
        element.title = `${cell.series}: ${text}`;
        element.style.cssText =
            'display:flex;flex-direction:column;align-items:center;' +
            'justify-content:center;min-width:0;overflow:hidden;' +
            'border-radius:4px;padding:4px;box-sizing:border-box;text-align:center';
        element.style.background = color;
        element.style.color = textOn(color);

        const name = document.createElement('div');
        name.setAttribute('data-testid', 'status-grid-series');
        name.style.cssText =
            'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        name.textContent = cell.series;

        const value = document.createElement('div');
        value.setAttribute('data-testid', 'status-grid-value');
        value.style.cssText =
            `font-size:${Math.round(size)}px;font-weight:500;line-height:1.2;` +
            'max-width:100%;overflow:hidden;text-overflow:ellipsis;' +
            'white-space:nowrap;font-variant-numeric:tabular-nums';
        value.textContent = text;

        element.append(name, value);
        grid.appendChild(element);
    }
    root.appendChild(grid);
};

const root = document.getElementById('root') ?? document.body;
onVizContext((context) => render(root, context));
