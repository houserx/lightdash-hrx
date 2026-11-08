import { formatGrafanaValue } from '../../shared/grafanaFormat';
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

const render = (root: HTMLElement, context: VizContext): void => {
    root.textContent = '';
    const options = context.options ?? {};
    const reducer = isReducer(options.reducer)
        ? options.reducer
        : DEFAULT_REDUCER;
    const unit = typeof options.unit === 'string' ? options.unit : '';
    const decimals = decimalsOption(options.decimals);

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
