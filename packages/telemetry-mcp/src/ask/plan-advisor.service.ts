/**
 * Port of the portal's plan advisor (`refs/db-query-portal@aea73de/api/src/services/plan-advisor.service.ts`).
 *
 * Asks the model for concrete improvement suggestions from an EXPLAIN plan. Advisory only: it never executes SQL.
 * The prompt, limits and parsing are the portal's. What changed in the port:
 * - The Anthropic SDK client (and its Secrets Manager key lookup) is replaced by the injected `LlmClient`.
 * - The portal read existing indexes from `pg_indexes`. The Platform Database contract exposes no `pg_*` access, so
 *   the lookup is an optional injected function; without one the prompt says the indexes could not be read, exactly
 *   as the portal did when its lookup failed.
 * - `HttpError` becomes `PlanAdviceError` (same status codes and messages); metrics and Sentry capture are dropped.
 * - The model defaults and token limit are options instead of portal env vars (same default values).
 * - `collectRelations` also walks arrays and `Plan` roots, so a whole `EXPLAIN (FORMAT JSON)` result (an array of
 *   `{ Plan: ... }`, which is what `platform_explain` returns) yields its tables, not just a bare plan node.
 * - `analyze` is optional (default false): MCP plans are always estimate-only.
 */
import { responseText, type LlmClient } from './llm.js';

export interface PlanSuggestion {
    title: string;
    detail: string;
    severity: 'high' | 'medium' | 'low';
    category: string;
    /** The table this suggestion applies to, for inline placement on the plan, when identifiable. */
    relation?: string;
}

export interface IndexSuggestion {
    table: string;
    columns: string[];
    statement: string;
    rationale: string;
}

export interface PlanAdvice {
    summary: string;
    suggestions: PlanSuggestion[];
    indexes: IndexSuggestion[];
    model: string;
}

export interface AdvisePlanInput {
    sql: string;
    /** Whether the plan came from EXPLAIN ANALYZE. MCP only produces estimate-only plans, so this defaults to false. */
    analyze?: boolean;
    plan: unknown;
    model?: string;
}

export interface ExistingIndex {
    tablename: string;
    indexdef: string;
}

/** Reads the existing indexes on the given base tables. */
export type ExistingIndexLookup = (relations: string[]) => Promise<ExistingIndex[]>;

export interface PlanAdvisorOptions {
    /** The model client; `null` means AI suggestions are not configured. */
    llm: LlmClient | null;
    /** Model used when the caller requests none (or one outside `AI_MODELS`). Portal: `ANTHROPIC_MODEL`. */
    defaultModel?: string;
    /** Portal: `AI_ADVICE_MAX_TOKENS`. */
    maxTokens?: number;
    existingIndexes?: ExistingIndexLookup;
}

export interface PlanAdvisor {
    advisePlan(input: AdvisePlanInput): Promise<PlanAdvice>;
}

/** Carries the portal's HTTP status: 503 when no model is configured, 502 when the model call fails. */
export class PlanAdviceError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'PlanAdviceError';
        this.status = status;
    }
}

/** Selectable models for the AI advisor, fastest first. */
export const AI_MODELS = [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku — fastest', speed: 'fast' as const },
    { id: 'claude-sonnet-4-6', label: 'Sonnet — slower, more thorough', speed: 'slow' as const },
];

export const DEFAULT_ADVICE_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_ADVICE_MAX_TOKENS = 1200;

export const NOT_CONFIGURED_MESSAGE =
    'AI suggestions are not configured for this environment (no Anthropic API key available).';

/** Only honor a requested model that's in the curated list; otherwise use the configured default. */
export function resolveModel(requested: string | undefined, defaultModel: string = DEFAULT_ADVICE_MODEL): string {
    return AI_MODELS.some((m) => m.id === requested) ? (requested as string) : defaultModel;
}

// Bound the prompt size; EXPLAIN plans are normally far smaller than this.
export const PLAN_CHAR_LIMIT = 24_000;

/** Collects the base-table names referenced anywhere in an EXPLAIN plan tree. */
export function collectRelations(plan: unknown): string[] {
    const names = new Set<string>();
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        // A FORMAT JSON plan is an array of `{ Plan: {...} }`; walk arrays and the `Plan` root too.
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        const o = node as Record<string, unknown>;
        if (typeof o['Relation Name'] === 'string') names.add(o['Relation Name']);
        if (o.Plan) walk(o.Plan);
        if (Array.isArray(o.Plans)) o.Plans.forEach(walk);
    };
    walk(plan);
    return [...names];
}

/** Describes existing indexes on the plan's tables so the model won't re-suggest ones we already have. */
async function describeExistingIndexes(
    lookup: ExistingIndexLookup | undefined,
    relations: string[],
): Promise<string> {
    if (relations.length === 0) return '(no base tables detected in the plan)';
    if (!lookup) return '(existing indexes could not be read)';
    try {
        const rows = await lookup(relations);
        if (rows.length === 0) return `Tables (${relations.join(', ')}) currently have no indexes.`;
        return rows.map((r) => `${r.tablename}: ${r.indexdef}`).join('\n');
    } catch {
        return '(existing indexes could not be read)';
    }
}

export const SYSTEM_PROMPT = `You are a senior PostgreSQL performance engineer helping a support engineer read a query's EXPLAIN plan.
Given the SQL, its plan (JSON), and the involved tables' EXISTING indexes, suggest concrete, correct optimizations: query rewrites, statistics/config fixes, and — most importantly — MISSING indexes that would remove sequential scans on large tables or expensive sorts/joins. Focus on the plan's real hotspots. Never invent columns or tables you cannot infer from the SQL or plan.

CRITICAL for indexes: only propose an index if an equivalent one does NOT already exist in the provided existing-index list. Each index suggestion must be a ready-to-run CREATE INDEX statement naming the exact table and column(s) in the order that helps this query.

Respond with ONLY a JSON object (no markdown fences, no text outside it) of the form:
{"summary": string, "suggestions": [{"title": string, "detail": string, "severity": "high"|"medium"|"low", "category": string, "relation": string}], "indexes": [{"table": string, "columns": [string], "statement": string, "rationale": string}]}
"relation" is the table a suggestion applies to (use "" if none). "statement" is a full CREATE INDEX statement. Keep "summary" to 1-2 sentences and each "detail"/"rationale" to 1-3 sentences. "category" is a short tag such as "index", "rewrite", "statistics", or "config". Return empty arrays when nothing applies; if the plan is already healthy, say so in the summary with empty arrays.`;

export function parseAdvice(text: string, model: string): PlanAdvice {
    // The model may wrap the JSON in prose/backticks despite instructions — extract the outer object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const slice = start !== -1 && end > start ? text.slice(start, end + 1) : '';
    try {
        const parsed = JSON.parse(slice) as {
            summary?: unknown;
            suggestions?: unknown;
            indexes?: unknown;
        };
        const suggestions: PlanSuggestion[] = Array.isArray(parsed.suggestions)
            ? parsed.suggestions.flatMap((raw: unknown) => {
                  if (!raw || typeof raw !== 'object') return [];
                  const o = raw as Record<string, unknown>;
                  const severity =
                      o.severity === 'high' || o.severity === 'medium' || o.severity === 'low' ? o.severity : 'low';
                  const relation = typeof o.relation === 'string' && o.relation ? o.relation : undefined;
                  return [
                      {
                          title: String(o.title ?? 'Suggestion'),
                          detail: String(o.detail ?? ''),
                          severity,
                          category: String(o.category ?? 'general'),
                          ...(relation ? { relation } : {}),
                      },
                  ];
              })
            : [];
        const indexes: IndexSuggestion[] = Array.isArray(parsed.indexes)
            ? parsed.indexes.flatMap((raw: unknown) => {
                  if (!raw || typeof raw !== 'object') return [];
                  const o = raw as Record<string, unknown>;
                  const statement = String(o.statement ?? '').trim();
                  if (!statement) return [];
                  const columns = Array.isArray(o.columns) ? o.columns.map((c: unknown) => String(c)) : [];
                  return [
                      {
                          table: String(o.table ?? ''),
                          columns,
                          statement,
                          rationale: String(o.rationale ?? ''),
                      },
                  ];
              })
            : [];
        const summary = typeof parsed.summary === 'string' && parsed.summary ? parsed.summary : text;
        return { summary, suggestions, indexes, model };
    } catch {
        // Not valid JSON — surface the raw text as the summary so the user still gets value.
        return {
            summary: text || 'No suggestions were returned.',
            suggestions: [],
            indexes: [],
            model,
        };
    }
}

/** The user message: SQL, plan (bounded to PLAN_CHAR_LIMIT) and the existing-index list. */
export function buildUserContent(input: AdvisePlanInput, existingIndexes: string): string {
    const planJson = JSON.stringify(input.plan) ?? 'null';
    const planText =
        planJson.length > PLAN_CHAR_LIMIT ? `${planJson.slice(0, PLAN_CHAR_LIMIT)}… (truncated)` : planJson;
    return `SQL:\n${input.sql}\n\nThe plan was produced with EXPLAIN${
        input.analyze ? ' ANALYZE (actual timings and row counts included)' : ' (estimates only)'
    }.\n\nPlan (JSON):\n${planText}\n\nExisting indexes on the involved tables:\n${existingIndexes}`;
}

export function createPlanAdvisor(options: PlanAdvisorOptions): PlanAdvisor {
    const defaultModel = options.defaultModel ?? DEFAULT_ADVICE_MODEL;
    const maxTokens = options.maxTokens ?? DEFAULT_ADVICE_MAX_TOKENS;

    return {
        /**
         * Throws `PlanAdviceError` when the model is unconfigured (503) or the call fails (502), so the caller
         * can surface a clear, non-fatal message.
         */
        async advisePlan(input: AdvisePlanInput): Promise<PlanAdvice> {
            const { llm } = options;
            if (!llm) throw new PlanAdviceError(503, NOT_CONFIGURED_MESSAGE);

            const existingIndexes = await describeExistingIndexes(
                options.existingIndexes,
                collectRelations(input.plan),
            );
            const userContent = buildUserContent(input, existingIndexes);
            const model = resolveModel(input.model, defaultModel);
            try {
                const message = await llm.createMessage({
                    model,
                    max_tokens: maxTokens,
                    system: SYSTEM_PROMPT,
                    messages: [{ role: 'user', content: userContent }],
                });
                return parseAdvice(responseText(message), model);
            } catch (err) {
                if (err instanceof PlanAdviceError) throw err;
                const msg = err instanceof Error ? err.message : 'Unknown error';
                throw new PlanAdviceError(502, `AI suggestion request failed: ${msg}`);
            }
        },
    };
}
