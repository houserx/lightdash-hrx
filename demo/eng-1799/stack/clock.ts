// ENG-1799 demo: the scenario clock every fake reads.
//
// The timeline is three instants: startedAt (the "T" of the walkthrough), incidentAt and recoveryAt.
// Fakes must compute their data at time t as a pure function of t and the current timeline, so a
// timeline shifted into the past (negative offsets) fills look-back windows at once.

export type Phase = 'baseline' | 'incident' | 'recovered';

export type Timeline = {
    startedAt: number; // epoch ms
    incidentAt: number; // epoch ms
    recoveryAt: number; // epoch ms
};

/** The JSON shape of GET /scenario and POST /scenario/restart (ISO strings). */
export type ScenarioView = {
    startedAt: string;
    incidentAt: string;
    recoveryAt: string;
    now: string;
    phase: Phase;
    incidentAfterSeconds: number;
    recoveryAfterSeconds: number;
};

/** Offsets are bounded so a timeline always stays inside the range a Date can represent. */
const MAX_OFFSET_SECONDS = 999_999_999;

export function phaseAt(timeline: Timeline, t: number): Phase {
    if (t < timeline.incidentAt) return 'baseline';
    if (t < timeline.recoveryAt) return 'incident';
    return 'recovered';
}

/** Returns an error message, or undefined when the offsets make a valid timeline. */
export function validateOffsets(incidentAfterSeconds: unknown, recoveryAfterSeconds: unknown): string | undefined {
    for (const [name, value] of [
        ['incidentAfterSeconds', incidentAfterSeconds],
        ['recoveryAfterSeconds', recoveryAfterSeconds],
    ] as const) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number of seconds`;
        if (Math.abs(value) > MAX_OFFSET_SECONDS) return `${name} must be within ±${MAX_OFFSET_SECONDS} seconds`;
    }
    if ((recoveryAfterSeconds as number) <= (incidentAfterSeconds as number)) {
        return 'recoveryAfterSeconds must be later than incidentAfterSeconds';
    }
    return undefined;
}

export class ScenarioClock {
    private timeline: Timeline;

    constructor(
        incidentAfterSeconds: number,
        recoveryAfterSeconds: number,
        private readonly now: () => number = Date.now,
    ) {
        this.timeline = this.build(incidentAfterSeconds, recoveryAfterSeconds);
    }

    /** Restarts the timeline at now; offsets are seconds from now and may be negative. Throws on invalid offsets. */
    restart(incidentAfterSeconds: number, recoveryAfterSeconds: number): Timeline {
        this.timeline = this.build(incidentAfterSeconds, recoveryAfterSeconds);
        return this.current();
    }

    current(): Timeline {
        return { ...this.timeline };
    }

    phaseAt(t: number): Phase {
        return phaseAt(this.timeline, t);
    }

    view(): ScenarioView {
        const t = this.now();
        const { startedAt, incidentAt, recoveryAt } = this.timeline;
        return {
            startedAt: new Date(startedAt).toISOString(),
            incidentAt: new Date(incidentAt).toISOString(),
            recoveryAt: new Date(recoveryAt).toISOString(),
            now: new Date(t).toISOString(),
            phase: phaseAt(this.timeline, t),
            incidentAfterSeconds: (incidentAt - startedAt) / 1000,
            recoveryAfterSeconds: (recoveryAt - startedAt) / 1000,
        };
    }

    private build(incidentAfterSeconds: number, recoveryAfterSeconds: number): Timeline {
        const error = validateOffsets(incidentAfterSeconds, recoveryAfterSeconds);
        if (error) throw new RangeError(error);
        const startedAt = this.now();
        return {
            startedAt,
            incidentAt: startedAt + Math.round(incidentAfterSeconds * 1000),
            recoveryAt: startedAt + Math.round(recoveryAfterSeconds * 1000),
        };
    }
}
