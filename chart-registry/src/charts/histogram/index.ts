import {
    onVizContext,
    option,
    rawValue,
    toNumber,
    type VizContext,
} from '../../shared/vizContext';
import { bucketValues } from './histogram';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_COLOR = '#7EB26D';
const MARGIN = { top: 12, right: 12, bottom: 28, left: 40 };

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

const formatEdge = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toPrecision(3);

const toHexColor = (color: string | undefined): string =>
    color && /^#[0-9a-f]{6}$/i.test(color)
        ? color.toUpperCase()
        : DEFAULT_COLOR;

const render = (root: HTMLElement, context: VizContext): void => {
    root.textContent = '';
    const values = context.rows
        .map((row) => toNumber(rawValue(context, row, 'value')))
        .filter((value): value is number => value !== null);
    const buckets = bucketValues(values, option(context, 'bucketCount', 10));

    if (buckets.length === 0) {
        const empty = document.createElement('div');
        empty.setAttribute('data-testid', 'histogram-empty');
        empty.className = 'empty';
        empty.textContent = 'No data';
        root.appendChild(empty);
        return;
    }

    const width = Math.max(root.clientWidth, 200);
    const height = Math.max(root.clientHeight, 120);
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = height - MARGIN.top - MARGIN.bottom;
    const maxCount = Math.max(...buckets.map((b) => b.count), 1);
    const barWidth = plotWidth / buckets.length;
    const color = toHexColor(context.colorPalette?.[0]);

    const chart = svg('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'data-testid': 'histogram',
    });
    const label = context.fields?.value?.label ?? 'Value';
    const title = svg('title', {});
    title.textContent = `Histogram of ${label}`;
    chart.appendChild(title);

    buckets.forEach((bucket, i) => {
        const barHeight = (bucket.count / maxCount) * plotHeight;
        const x = MARGIN.left + i * barWidth;
        const bar = svg('rect', {
            x: x + 1,
            y: MARGIN.top + plotHeight - barHeight,
            width: Math.max(barWidth - 2, 1),
            height: barHeight,
            fill: color,
            'data-testid': 'histogram-bar',
            'data-count': bucket.count,
            'data-from': bucket.from,
            'data-to': bucket.to,
            'data-color': color,
        });
        const tooltip = svg('title', {});
        tooltip.textContent = `${formatEdge(bucket.from)} – ${formatEdge(bucket.to)}: ${bucket.count}`;
        bar.appendChild(tooltip);
        chart.appendChild(bar);

        const edge = svg('text', {
            x,
            y: height - 8,
            'text-anchor': 'middle',
            class: 'axis',
        });
        edge.textContent = formatEdge(bucket.from);
        chart.appendChild(edge);
    });
    const lastEdge = svg('text', {
        x: MARGIN.left + plotWidth,
        y: height - 8,
        'text-anchor': 'middle',
        class: 'axis',
    });
    lastEdge.textContent = formatEdge(buckets[buckets.length - 1].to);
    chart.appendChild(lastEdge);

    const top = svg('text', {
        x: MARGIN.left - 6,
        y: MARGIN.top + 4,
        'text-anchor': 'end',
        class: 'axis',
    });
    top.textContent = String(maxCount);
    chart.appendChild(top);
    chart.appendChild(
        svg('line', {
            x1: MARGIN.left,
            x2: MARGIN.left + plotWidth,
            y1: MARGIN.top + plotHeight,
            y2: MARGIN.top + plotHeight,
            class: 'baseline',
        }),
    );
    root.appendChild(chart);
};

const root = document.getElementById('root') ?? document.body;
onVizContext((context) => render(root, context));
