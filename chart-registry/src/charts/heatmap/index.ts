import {
    onVizContext,
    rawValue,
    toNumber,
    type VizContext,
} from '../../shared/vizContext';
import { buildHeatmap, interpolateColor } from './heatmap';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 12, right: 12, bottom: 28, left: 48 };
const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_SCALE = {
    colors: ['#FCE2C9', '#FF9830', '#C4162A'],
    min: 'auto' as number | 'auto',
    max: 'auto' as number | 'auto',
};

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

/** The `colorScale` gradient option, falling back per part when malformed. */
const colorScale = (context: VizContext): typeof DEFAULT_SCALE => {
    const value = context.options?.colorScale as
        | { colors?: unknown; min?: unknown; max?: unknown }
        | undefined;
    const colors = Array.isArray(value?.colors)
        ? value.colors.filter(
              (c): c is string => typeof c === 'string' && HEX.test(c),
          )
        : [];
    const bound = (b: unknown): number | 'auto' =>
        typeof b === 'number' && Number.isFinite(b) ? b : 'auto';
    return {
        colors: colors.length > 0 ? colors : DEFAULT_SCALE.colors,
        min: bound(value?.min),
        max: bound(value?.max),
    };
};

/** A time cell as text: ISO strings as given, epoch millis and dates as ISO. */
const timeText = (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (raw instanceof Date) {
        return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
    }
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
    }
    return String(raw);
};

const bucketText = (raw: unknown): string | null =>
    raw === null || raw === undefined || raw === '' ? null : String(raw).trim();

const timeLabel = (time: string): string => {
    const date = new Date(time);
    return Number.isNaN(date.getTime())
        ? time
        : date.toISOString().slice(11, 16);
};

const render = (root: HTMLElement, context: VizContext): void => {
    root.textContent = '';
    const model = buildHeatmap(
        context.rows.map((row) => ({
            time: timeText(rawValue(context, row, 'time')),
            bucket: bucketText(rawValue(context, row, 'bucket')),
            value: toNumber(rawValue(context, row, 'value')),
        })),
    );

    if (model.cells.length === 0) {
        const empty = document.createElement('div');
        empty.setAttribute('data-testid', 'heatmap-empty');
        empty.className = 'empty';
        empty.textContent = 'No data';
        root.appendChild(empty);
        return;
    }

    const scale = colorScale(context);
    const min = scale.min === 'auto' ? model.min : scale.min;
    const max = scale.max === 'auto' ? model.max : scale.max;
    const colorFor = (value: number) =>
        interpolateColor(
            scale.colors,
            max === min ? 1 : (value - min) / (max - min),
        );

    const width = Math.max(root.clientWidth, 200);
    const height = Math.max(root.clientHeight, 120);
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = height - MARGIN.top - MARGIN.bottom;
    const cellWidth = plotWidth / model.times.length;
    const cellHeight = plotHeight / model.buckets.length;
    const column = new Map(model.times.map((t, i) => [t, i]));
    // Lowest bucket at the bottom, +Inf at the top, as in Grafana.
    const row = new Map(
        model.buckets.map((b, i) => [b, model.buckets.length - 1 - i]),
    );

    const chart = svg('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'data-testid': 'heatmap',
    });
    const title = svg('title', {});
    title.textContent = `Heatmap of ${context.fields?.value?.label ?? 'Value'} by ${
        context.fields?.bucket?.label ?? 'Bucket'
    } over ${context.fields?.time?.label ?? 'Time'}`;
    chart.appendChild(title);

    for (const cell of model.cells) {
        const color = colorFor(cell.value);
        const rect = svg('rect', {
            x: MARGIN.left + column.get(cell.time)! * cellWidth,
            y: MARGIN.top + row.get(cell.bucket)! * cellHeight,
            width: Math.max(cellWidth - 1, 1),
            height: Math.max(cellHeight - 1, 1),
            fill: color,
            'data-testid': 'heatmap-cell',
            'data-time': cell.time,
            'data-bucket': cell.bucket,
            'data-value': cell.value,
            'data-color': color,
        });
        const tooltip = svg('title', {});
        tooltip.textContent = `${cell.time} · ≤ ${cell.bucket}: ${cell.value}`;
        rect.appendChild(tooltip);
        chart.appendChild(rect);
    }

    // y labels in bucket order (lowest first); drawn bottom to top.
    model.buckets.forEach((bucket) => {
        const label = svg('text', {
            x: MARGIN.left - 6,
            y: MARGIN.top + (row.get(bucket)! + 0.5) * cellHeight + 4,
            'text-anchor': 'end',
            class: 'axis',
            'data-testid': 'heatmap-y-label',
        });
        label.textContent = bucket;
        chart.appendChild(label);
    });

    // At most ~8 x labels so they do not overlap.
    const step = Math.max(1, Math.ceil(model.times.length / 8));
    model.times.forEach((time, i) => {
        if (i % step !== 0) return;
        const label = svg('text', {
            x: MARGIN.left + (i + 0.5) * cellWidth,
            y: height - 8,
            'text-anchor': 'middle',
            class: 'axis',
            'data-testid': 'heatmap-x-label',
        });
        label.textContent = timeLabel(time);
        chart.appendChild(label);
    });

    root.appendChild(chart);
};

const root = document.getElementById('root') ?? document.body;
onVizContext((context) => render(root, context));
