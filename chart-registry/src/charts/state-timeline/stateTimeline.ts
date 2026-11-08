/**
 * The state-timeline model: one row per series, and in each row one
 * segment per run of the same state over time, as Grafana's state
 * timeline panel draws them.
 */

export type StatePoint = {
    /** Epoch milliseconds, or null when the row has no usable time. */
    time: number | null;
    series: string | null;
    /** The raw state (kept raw so numeric value mappings still apply). */
    state: unknown;
};

export type StateSegment = {
    /** The state as text, the identity of a run. */
    state: string;
    /** The first row's raw state, for value mappings. */
    raw: unknown;
    start: number;
    end: number;
};

export type StateTimelineRow = {
    series: string;
    segments: StateSegment[];
};

export type StateTimeline = {
    rows: StateTimelineRow[];
    /** Distinct states in order of first appearance (by time, then row). */
    states: { state: string; raw: unknown }[];
    /** Distinct sample times, ascending. */
    times: number[];
    start: number;
    end: number;
};

const isMissing = (state: unknown): boolean =>
    state === null || state === undefined || String(state).trim() === '';

/**
 * Builds the timeline. Rows without a time or series are skipped. Series
 * keep the order they first appear in. Within a series, points are read in
 * time order and consecutive points with the same state merge into one
 * segment, which lasts until the next point's time. The last point of
 * every series lasts until the end of the domain: the latest time plus the
 * smallest gap between distinct times (one sample interval), so a lone
 * last sample is still drawn. A missing (null or blank) state ends the run
 * before it and leaves a gap, as Grafana does with nulls.
 */
export const buildStateTimeline = (points: StatePoint[]): StateTimeline => {
    const bySeries = new Map<string, { time: number; state: unknown }[]>();
    for (const point of points) {
        if (point.time === null || point.series === null) continue;
        const list = bySeries.get(point.series) ?? [];
        list.push({ time: point.time, state: point.state });
        bySeries.set(point.series, list);
    }

    const times = [
        ...new Set([...bySeries.values()].flat().map((p) => p.time)),
    ].sort((a, b) => a - b);
    if (times.length === 0)
        return { rows: [], states: [], times, start: 0, end: 0 };
    let step = Number.POSITIVE_INFINITY;
    for (let i = 1; i < times.length; i += 1) {
        step = Math.min(step, times[i] - times[i - 1]);
    }
    if (!Number.isFinite(step)) step = 1;
    const start = times[0];
    const end = times[times.length - 1] + step;

    const firstSeen = new Map<
        string,
        { at: number; order: number; raw: unknown }
    >();
    let order = 0;
    const rows: StateTimelineRow[] = [];
    for (const [series, list] of bySeries) {
        // Stable sort keeps row order for points at the same time.
        const sorted = [...list].sort((a, b) => a.time - b.time);
        const segments: StateSegment[] = [];
        let open: StateSegment | null = null;
        for (const point of sorted) {
            if (isMissing(point.state)) {
                if (open) open.end = point.time;
                open = null;
                continue;
            }
            const state = String(point.state).trim();
            if (!firstSeen.has(state)) {
                firstSeen.set(state, {
                    at: point.time,
                    order,
                    raw: point.state,
                });
                order += 1;
            }
            if (open && open.state === state) continue;
            if (open) open.end = point.time;
            open = { state, raw: point.state, start: point.time, end };
            segments.push(open);
        }
        rows.push({
            series,
            segments: segments.filter((s) => s.end > s.start),
        });
    }

    const states = [...firstSeen.entries()]
        .sort(([, a], [, b]) => a.at - b.at || a.order - b.order)
        .map(([state, { raw }]) => ({ state, raw }));
    return { rows, states, times, start, end };
};
