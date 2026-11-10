// ENG-1799 demo line: scenario windows used by the fake-source checks. PROTECTED.
//
// Pinned data contract (PROGRESS.md "Scenario data"): data at time t is a pure function of t and the current
// timeline. Restarting with incident 240 s ago and recovery 90 s ago gives, in one look-back window:
//   baseline   [now-400s, now-250s]      (before incidentAt)
//   incident   [now-205s, now-95s]       (incidentAt+35s .. recoveryAt-5s)
//   recovered  [now-25s,  now]           (after recoveryAt+65s)
import type { Stack } from './stack';
import { restartScenario } from './stack';

export type Windows = {
    baseline: [Date, Date];
    incident: [Date, Date];
    recovered: [Date, Date];
    from: Date;
    to: Date;
};

export async function shiftScenarioIntoPast(stack: Stack): Promise<Windows> {
    const r = await restartScenario(stack, -240, -90);
    const now = new Date(r.now).getTime();
    const at = (s: number) => new Date(now + s * 1000);
    return {
        baseline: [at(-400), at(-250)],
        incident: [at(-205), at(-95)],
        recovered: [at(-25), at(0)],
        from: at(-400),
        to: at(0),
    };
}

export const inWindow = (t: Date | string, [a, b]: [Date, Date]) => {
    const x = new Date(t).getTime();
    return x >= a.getTime() && x <= b.getTime();
};

export const minutes = ([a, b]: [Date, Date]) => (b.getTime() - a.getTime()) / 60_000;
