import { type ResultRow } from '@lightdash/common';
import { type ResolvedTraceWaterfallChartConfig } from './config';

/** One span, placed in its trace's waterfall. */
export type TraceWaterfallSpan = {
    spanId: string;
    /** Null for a root span (no parent in the data's column). */
    parentSpanId: string | null;
    traceId: string;
    service: string;
    name: string;
    status: string;
    /** The span's attributes, parsed from an object or its JSON text. */
    attributes: Record<string, unknown>;
    /** Milliseconds from the trace start to the span start (0 with no valid time). */
    offsetMs: number;
    /** Milliseconds the bar spans. */
    durationMs: number;
    /** The duration the data reported, for the detail view. */
    reportedDurationMs: number;
    /** 0 for roots, one more per ancestor. */
    depth: number;
    /** Its parent is not in the results, so it is drawn as a root. */
    isOrphan: boolean;
    /** Its window was moved into its parent's because of clock skew. */
    isClamped: boolean;
    /** The colour of its service: one per service across the model. */
    color: string;
};

/** One trace: its spans in waterfall order and its time window. */
export type TraceWaterfallTrace = {
    traceId: string;
    /** Milliseconds since the epoch at which the trace's roots start. */
    startMs: number;
    /** From `startMs` to the latest end of the trace's roots. */
    durationMs: number;
    /** Depth first; roots and each span's children ordered by start. */
    spans: TraceWaterfallSpan[];
};

/** What a trace waterfall draws: its traces, in row order of first appearance. */
export type TraceWaterfallModel = {
    traces: TraceWaterfallTrace[];
};

type RawSpan = {
    index: number;
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    service: string;
    name: string;
    status: string;
    attributes: Record<string, unknown>;
    startMs: number | null;
    reportedDurationMs: number;
};

/** The bar colour when the palette given is empty. */
const NO_PALETTE_COLOR = '#8E8E8E';

type PlacedSpan = { span: RawSpan; depth: number; isOrphan: boolean };

const rawOf = (row: ResultRow, fieldId: string | undefined): unknown =>
    fieldId === undefined ? undefined : row[fieldId]?.value?.raw;

const toText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const toTime = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const time =
        value instanceof Date
            ? value.getTime()
            : typeof value === 'number'
              ? value
              : new Date(String(value)).getTime();
    return Number.isFinite(time) ? time : null;
};

const toDuration = (value: unknown): number => {
    if (value === null || value === undefined || value === '') return 0;
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
};

/** Attributes from an object or its JSON text; anything else has none. */
export const parseSpanAttributes = (
    value: unknown,
): Record<string, unknown> => {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return {};
        }
    }
    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        return {};
    }
    return { ...(parsed as Record<string, unknown>) };
};

const toRawSpan = (
    row: ResultRow,
    index: number,
    config: ResolvedTraceWaterfallChartConfig,
): RawSpan => {
    const parent = toText(rawOf(row, config.parentSpanIdFieldId)).trim();
    return {
        index,
        traceId: toText(rawOf(row, config.traceIdFieldId)),
        spanId: toText(rawOf(row, config.spanIdFieldId)),
        parentSpanId: parent === '' ? null : parent,
        service: toText(rawOf(row, config.serviceFieldId)),
        name: toText(rawOf(row, config.nameFieldId)),
        status: toText(rawOf(row, config.statusFieldId)),
        attributes: parseSpanAttributes(rawOf(row, config.attributesFieldId)),
        startMs: toTime(rawOf(row, config.startFieldId)),
        reportedDurationMs: toDuration(rawOf(row, config.durationMsFieldId)),
    };
};

/** By start time, spans with no time last; ties keep the data's order. */
const byStart = (a: RawSpan, b: RawSpan): number => {
    if (a.startMs !== b.startMs) {
        if (a.startMs === null) return 1;
        if (b.startMs === null) return -1;
        return a.startMs - b.startMs;
    }
    return a.index - b.index;
};

/**
 * Places a trace's spans depth first, roots and children ordered by start.
 * A span whose parent is not in the trace is a root, marked as an orphan.
 * Spans only reachable through a parent cycle are rooted the same way, so
 * no span is ever dropped.
 */
const placeSpans = (spans: RawSpan[]): PlacedSpan[] => {
    const ids = new Set(spans.map((s) => s.spanId));
    const children = new Map<string, RawSpan[]>();
    const roots: RawSpan[] = [];
    spans.forEach((span) => {
        const parent = span.parentSpanId;
        if (parent === null || parent === span.spanId || !ids.has(parent)) {
            roots.push(span);
            return;
        }
        const siblings = children.get(parent);
        if (siblings) siblings.push(span);
        else children.set(parent, [span]);
    });
    children.forEach((list) => list.sort(byStart));

    const placed: PlacedSpan[] = [];
    const visited = new Set<number>();
    const visit = (root: RawSpan) => {
        const stack: { span: RawSpan; depth: number }[] = [
            { span: root, depth: 0 },
        ];
        while (stack.length > 0) {
            const { span, depth } = stack.pop()!;
            if (!visited.has(span.index)) {
                visited.add(span.index);
                placed.push({
                    span,
                    depth,
                    isOrphan: depth === 0 && span.parentSpanId !== null,
                });
                const kids = children.get(span.spanId) ?? [];
                for (let i = kids.length - 1; i >= 0; i -= 1) {
                    stack.push({ span: kids[i], depth: depth + 1 });
                }
            }
        }
    };
    [...roots].sort(byStart).forEach(visit);
    // Cycles: root the earliest unplaced span until every span is placed.
    let rest = spans.filter((s) => !visited.has(s.index));
    while (rest.length > 0) {
        visit([...rest].sort(byStart)[0]);
        rest = rest.filter((s) => !visited.has(s.index));
    }
    return placed;
};

const buildTrace = (
    traceId: string,
    spans: RawSpan[],
    colorOf: (service: string) => string,
): TraceWaterfallTrace => {
    const placed = placeSpans(spans);
    const timedRoots = placed.filter(
        (p) => p.depth === 0 && p.span.startMs !== null,
    );
    const windowSpans =
        timedRoots.length > 0
            ? timedRoots.map((p) => p.span)
            : spans.filter((s) => s.startMs !== null);
    const startMs =
        windowSpans.length > 0
            ? Math.min(...windowSpans.map((s) => s.startMs!))
            : 0;
    const endMs =
        windowSpans.length > 0
            ? Math.max(
                  ...windowSpans.map((s) => s.startMs! + s.reportedDurationMs),
              )
            : startMs;
    return {
        traceId,
        startMs,
        durationMs: endMs - startMs,
        spans: placed.map(({ span, depth, isOrphan }) => ({
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            traceId: span.traceId,
            service: span.service,
            name: span.name,
            status: span.status,
            attributes: span.attributes,
            offsetMs: span.startMs === null ? 0 : span.startMs - startMs,
            durationMs: span.reportedDurationMs,
            reportedDurationMs: span.reportedDurationMs,
            depth,
            isOrphan,
            isClamped: false,
            color: colorOf(span.service),
        })),
    };
};

/**
 * Turns `trace()` span rows into the traces a waterfall draws. Traces come
 * in row order of first appearance; each service takes the next palette
 * colour in waterfall order, the same in every trace.
 */
export const buildTraceWaterfallModel = ({
    rows,
    config,
    palette,
}: {
    rows: ResultRow[];
    config: ResolvedTraceWaterfallChartConfig;
    palette: readonly string[];
}): TraceWaterfallModel => {
    const byTrace = new Map<string, RawSpan[]>();
    rows.forEach((row, index) => {
        const span = toRawSpan(row, index, config);
        const spans = byTrace.get(span.traceId);
        if (spans) spans.push(span);
        else byTrace.set(span.traceId, [span]);
    });
    const serviceColors = new Map<string, string>();
    const colorOf = (service: string): string => {
        let color = serviceColors.get(service);
        if (color === undefined) {
            color =
                palette.length > 0
                    ? palette[serviceColors.size % palette.length]
                    : NO_PALETTE_COLOR;
            serviceColors.set(service, color);
        }
        return color;
    };
    return {
        traces: [...byTrace].map(([traceId, spans]) =>
            buildTrace(traceId, spans, colorOf),
        ),
    };
};
