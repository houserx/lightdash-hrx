/**
 * Port of the portal's `answer-verification.ts` (refs/db-query-portal@aea73de), logic unchanged.
 *
 * Checks that the figures an answer states are backed by the query results it was built from: they
 * appear in the rows, or are plain arithmetic over them (totals, shares, differences, ratios). It is
 * a heuristic safety net against invented or mis-copied numbers, not a proof of correctness.
 */

export interface EvidenceQuery {
    status: 'ok' | 'error';
    sql: string;
    rows: Record<string, unknown>[];
}

export interface Figure {
    raw: string;
    value: number;
    decimals: number;
    percent: boolean;
}

const MAX_FIGURES_REPORTED = 6;
const MAX_GROUPS = 150;
const MAX_GROUP_VALUES = 50;
const MAX_SCALAR_POOL = 60;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const MONTHS =
    'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** Removes dates, years, times and list numbering, which are labels rather than reported figures. */
function stripNoise(text: string): string {
    return text
        .replace(/^\s*\d+[.)]\s/gm, ' ')
        .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, ' ')
        .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
        .replace(
            new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, 'gi'),
            ' ',
        )
        .replace(
            new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b(?:\\s+\\d{4})?`, 'gi'),
            ' ',
        )
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
}

const FIGURE_RE = /(?<![\w.])\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|[KkMmBb](?![a-zA-Z]))?/g;

export function extractFigures(text: string): Figure[] {
    const figures: Figure[] = [];
    for (const m of stripNoise(text).matchAll(FIGURE_RE)) {
        const suffix = m[3];
        const scale = suffix && suffix !== '%' ? (SCALE[suffix.toLowerCase()] ?? 1) : 1;
        const value = Number(`${(m[1] ?? '').replace(/,/g, '')}${m[2] ?? ''}`) * scale;
        if (!Number.isFinite(value)) continue;
        figures.push({
            raw: m[0].trim(),
            value,
            decimals: m[2] ? m[2].length - 1 : 0,
            percent: suffix === '%',
        });
    }
    return figures;
}

/** Half a unit in the last written place, scaled for K/M/B suffixes (e.g. "1.2M" tolerates ±50K). */
function toleranceOf(f: Figure): number {
    const suffixScale = /[KkMmBb]$/.test(f.raw) ? (SCALE[f.raw.slice(-1).toLowerCase()] ?? 1) : 1;
    return 0.5 * 10 ** -f.decimals * suffixScale + 1e-9;
}

function numericValue(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

interface Evidence {
    direct: Set<number>;
    groups: number[][];
    rowPairs: [number, number][];
    scalars: number[];
}

function collectEvidence(queries: EvidenceQuery[], question: string): Evidence {
    const direct = new Set<number>([0, 1]);
    const groups: number[][] = [];
    const rowPairs: [number, number][] = [];
    const scalars: number[] = [];

    for (const f of extractFigures(question)) direct.add(f.value);

    for (const q of queries.filter((x) => x.status === 'ok')) {
        for (const m of q.sql.matchAll(/\b\d+(?:\.\d+)?\b/g)) direct.add(Number(m[0]));
        for (let i = 0; i <= q.rows.length; i += 1) direct.add(i);

        const columns = new Map<string, number[]>();
        for (const row of q.rows) {
            const numbers: number[] = [];
            for (const [col, cell] of Object.entries(row)) {
                const n = numericValue(cell);
                if (n !== null) {
                    direct.add(Math.abs(n));
                    numbers.push(Math.abs(n));
                    const list = columns.get(col) ?? [];
                    list.push(Math.abs(n));
                    columns.set(col, list);
                } else if (typeof cell === 'string') {
                    for (const m of cell.matchAll(/\d+(?:\.\d+)?/g)) direct.add(Number(m[0]));
                }
            }
            for (let i = 0; i < numbers.length; i += 1) {
                for (let j = 0; j < numbers.length; j += 1) {
                    if (i !== j) rowPairs.push([numbers[i] as number, numbers[j] as number]);
                }
            }
            if (q.rows.length <= 3) scalars.push(...numbers);
        }
        for (const list of columns.values()) {
            if (groups.length < MAX_GROUPS) groups.push(list.slice(0, MAX_GROUP_VALUES));
        }
    }
    return {
        direct,
        groups,
        rowPairs: rowPairs.slice(0, 20_000),
        scalars: scalars.slice(0, MAX_SCALAR_POOL),
    };
}

/** Arithmetic a reader would do on two result values: total, gap, ratio, share, percent change. */
function* combine(a: number, b: number): Generator<number> {
    yield a + b;
    yield Math.abs(a - b);
    if (b !== 0) {
        yield a / b;
        yield (a / b) * 100;
        yield (Math.abs(a - b) / b) * 100;
    }
}

function isBacked(f: Figure, ev: Evidence): boolean {
    const tol = toleranceOf(f);
    const hits = (c: number): boolean =>
        Math.abs(c - f.value) <= tol || (f.percent && Math.abs(c * 100 - f.value) <= tol);

    for (const c of ev.direct) if (hits(c)) return true;

    for (const g of ev.groups) {
        const sum = g.reduce((s, v) => s + v, 0);
        if (hits(sum) || hits(sum / g.length)) return true;
        for (const v of g) if (sum !== 0 && hits((v / sum) * 100)) return true;
        for (const a of g) for (const b of g) for (const c of combine(a, b)) if (hits(c)) return true;
    }
    for (const [a, b] of ev.rowPairs) for (const c of combine(a, b)) if (hits(c)) return true;
    for (const a of ev.scalars)
        for (const b of ev.scalars) for (const c of combine(a, b)) if (hits(c)) return true;
    return false;
}

/**
 * Figures stated in the answer that neither appear in the query results (or the question / SQL) nor
 * follow from simple arithmetic over them. Empty when everything checks out.
 */
export function unverifiedFigures(
    answer: string,
    question: string,
    queries: EvidenceQuery[],
): string[] {
    if (!queries.some((q) => q.status === 'ok')) return [];
    const evidence = collectEvidence(queries, question);
    const missing = extractFigures(answer)
        .filter((f) => !isBacked(f, evidence))
        .map((f) => f.raw);
    return [...new Set(missing)].slice(0, MAX_FIGURES_REPORTED);
}
