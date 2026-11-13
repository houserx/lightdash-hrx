import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';

// CONTRACTS.md §7: the complete tool surface, nothing more.
const TOOLS = [
    'list_sources',
    'query_promql',
    'query_logql',
    'query_cloudwatch',
    'query_cloudwatch_logs',
    'search_traces',
    'get_trace',
    'alert_state',
    'alert_history',
    'platform_schema',
    'platform_query',
    'platform_explain',
    'ask_data',
    'write_preview',
];

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('tool catalog', () => {
    it('exposes exactly the contract tools to a known user', async () => {
        const names = (await h.listTools()).map((t) => t.name).sort();
        expect(names).toEqual([...TOOLS].sort());
    });

    it('gives every tool a description and an object input schema with described properties', async () => {
        for (const t of await h.listTools()) {
            expect(t.description, t.name).toBeTruthy();
            expect(t.description.length, t.name).toBeGreaterThan(20);
            expect(t.inputSchema?.type, t.name).toBe('object');
            for (const [prop, schema] of Object.entries(t.inputSchema.properties ?? {})) {
                expect((schema as { description?: string }).description, `${t.name}.${prop}`).toBeTruthy();
            }
        }
    });

    it('marks read-only tools with readOnlyHint', async () => {
        for (const t of await h.listTools()) {
            if (t.name === 'write_preview' || t.name === 'ask_data') continue;
            expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        }
    });

    it('describes tools using the glossary: Platform Database, Audited Query, Preview, Telemetry Source', async () => {
        const text = (await h.listTools()).map((t) => t.description).join('\n');
        expect(text).toContain('Platform Database');
        expect(text).toContain('Audited Query');
        expect(text).toContain('Preview');
        expect(text).toContain('Telemetry Source');
        expect(text.toLowerCase()).not.toMatch(/\bdatasource\b|dry run|prod db/);
    });
});
