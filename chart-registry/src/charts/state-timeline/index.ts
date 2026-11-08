import { mapValue, parseValueMappings } from '../../shared/valueMappings';
import {
    onVizContext,
    rawValue,
    type VizContext,
} from '../../shared/vizContext';
import { buildStateTimeline } from './stateTimeline';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 8, right: 12, bottom: 24, left: 96 };
const LEGEND_HEIGHT = 24;
const ROW_GAP = 4;
const MAX_ROW_HEIGHT = 48;
const HEX = /^#[0-9a-f]{6}$/i;
// Grafana's classic palette, used when the host sends no palette.
const CLASSIC_PALETTE = [
    '#7EB26D',
    '#EAB839',
    '#6ED0E0',
    '#EF843C',
    '#E24D42',
    '#1F78C1',
    '#BA43A9',
    '#705DA0',
];

const svg = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, String(value));
    }
    return element;
};

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

/** HH:MM UTC, or HH:MM:SS when `seconds` (samples closer than a minute). */
const clock = (millis: number, seconds = false): string =>
    new Date(millis).toISOString().slice(11, seconds ? 19 : 16);

const render = (root: HTMLElement, context: VizContext): void => {
    root.textContent = '';
    const model = buildStateTimeline(
        context.rows.map((row) => ({
            time: toMillis(rawValue(context, row, 'time')),
            series: seriesText(rawValue(context, row, 'series')),
            state: rawValue(context, row, 'state'),
        })),
    );

    if (model.rows.every((row) => row.segments.length === 0)) {
        const empty = document.createElement('div');
        empty.setAttribute('data-testid', 'state-timeline-empty');
        empty.className = 'empty';
        empty.textContent = 'No data';
        root.appendChild(empty);
        return;
    }

    // Each state's text and colour: its value mapping when one matches,
    // else the state itself in the next palette colour.
    const mappings = parseValueMappings(context.options?.valueMappings);
    const palette = (context.colorPalette ?? []).filter((c) => HEX.test(c));
    const colors = palette.length > 0 ? palette : CLASSIC_PALETTE;
    const look = new Map(
        model.states.map(({ state, raw }, i) => {
            const mapped = mapValue(raw, mappings);
            const color = mapped?.color?.trim() || colors[i % colors.length];
            return [
                state,
                {
                    text: mapped?.text ?? state,
                    color: HEX.test(color) ? color.toUpperCase() : color,
                },
            ];
        }),
    );

    const width = Math.max(root.clientWidth, 240);
    const height = Math.max(root.clientHeight - LEGEND_HEIGHT, 80);
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const rowHeight = Math.min(
        (height - MARGIN.top - MARGIN.bottom) / model.rows.length,
        MAX_ROW_HEIGHT,
    );
    const x = (millis: number) =>
        MARGIN.left +
        ((millis - model.start) / (model.end - model.start)) * plotWidth;
    const chartHeight =
        MARGIN.top + rowHeight * model.rows.length + MARGIN.bottom;

    const chart = svg('svg', {
        width,
        height: chartHeight,
        viewBox: `0 0 ${width} ${chartHeight}`,
        role: 'img',
        'data-testid': 'state-timeline',
    });
    const title = svg('title', {});
    title.textContent = `${context.fields?.state?.label ?? 'State'} of each ${
        context.fields?.series?.label ?? 'Series'
    } over ${context.fields?.time?.label ?? 'Time'}`;
    chart.appendChild(title);

    model.rows.forEach((row, i) => {
        const top = MARGIN.top + i * rowHeight;
        const group = svg('g', {
            'data-testid': 'state-timeline-row',
            'data-series': row.series,
        });
        const label = svg('text', {
            x: MARGIN.left - 8,
            y: top + rowHeight / 2 + 4,
            'text-anchor': 'end',
            class: 'axis',
            'data-testid': 'state-timeline-series-label',
        });
        label.textContent = row.series;
        group.appendChild(label);

        for (const segment of row.segments) {
            const { text, color } = look.get(segment.state)!;
            const left = x(segment.start);
            const segmentWidth = Math.max(x(segment.end) - left - 1, 1);
            const rect = svg('rect', {
                x: left,
                y: top + ROW_GAP / 2,
                width: segmentWidth,
                height: Math.max(rowHeight - ROW_GAP, 1),
                fill: color,
                'data-testid': 'state-timeline-segment',
                'data-state': segment.state,
                'data-text': text,
                'data-start': new Date(segment.start).toISOString(),
                'data-end': new Date(segment.end).toISOString(),
                'data-color': color,
            });
            const tooltip = svg('title', {});
            tooltip.textContent = `${row.series}: ${text} (${clock(
                segment.start,
            )} – ${clock(segment.end)})`;
            rect.appendChild(tooltip);
            group.appendChild(rect);

            // The state text inside the segment when it fits.
            if (segmentWidth >= text.length * 7 + 8 && rowHeight >= 14) {
                const caption = svg('text', {
                    x: left + segmentWidth / 2,
                    y: top + rowHeight / 2 + 4,
                    'text-anchor': 'middle',
                    fill: '#1F1F1F',
                    'font-size': 11,
                    'pointer-events': 'none',
                });
                caption.textContent = text;
                group.appendChild(caption);
            }
        }
        chart.appendChild(group);
    });

    // Time axis: a label at each sample time and at the end, thinned to
    // fit (one label per 80px at most), so labels never repeat.
    const ticks = [...model.times, model.end];
    const seconds = ticks.some((millis) => millis % 60_000 !== 0);
    const every = Math.max(
        1,
        Math.ceil(ticks.length / Math.max(2, Math.floor(plotWidth / 80))),
    );
    ticks.forEach((millis, i) => {
        if (i % every !== 0) return;
        const label = svg('text', {
            x: x(millis),
            y: chartHeight - 8,
            'text-anchor':
                i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle',
            class: 'axis',
            'data-testid': 'state-timeline-x-label',
        });
        label.textContent = clock(millis, seconds);
        chart.appendChild(label);
    });
    root.appendChild(chart);

    const legend = document.createElement('div');
    legend.style.cssText =
        'display:flex;flex-wrap:wrap;gap:4px 12px;padding:4px 0 0 ' +
        `${MARGIN.left}px;line-height:16px`;
    legend.setAttribute('data-testid', 'state-timeline-legend');
    for (const { state } of model.states) {
        const { text, color } = look.get(state)!;
        const item = document.createElement('span');
        item.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
        item.setAttribute('data-testid', 'state-timeline-legend-item');
        item.setAttribute('data-state', state);
        item.setAttribute('data-color', color);
        const swatch = document.createElement('span');
        swatch.style.cssText =
            'display:inline-block;width:10px;height:10px;border-radius:2px';
        swatch.style.background = color;
        item.append(swatch, text);
        legend.appendChild(item);
    }
    root.appendChild(legend);
};

const root = document.getElementById('root') ?? document.body;
onVizContext((context) => render(root, context));
