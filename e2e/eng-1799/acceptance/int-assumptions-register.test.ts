/* eslint-disable */
// @ts-nocheck
// int-assumptions-register: docs/eng-1799/contract-assumptions.md collects every "Contract
// assumptions" entry from every line, one table row each, with a decision; the numbered lists in
// the line progress files are all there, the session-log assumptions are there too, and each
// cross-line conflict is decided with a change on the losing side.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from './support';

const DOC = path.join(REPO_ROOT, 'docs/eng-1799/contract-assumptions.md');

const NUMBERED: Record<string, string[]> = {
    engine: Array.from({ length: 30 }, (_, i) => `engine-A${i + 1}`),
    ldq: Array.from({ length: 12 }, (_, i) => `ldq-${i + 1}`),
    mcp: Array.from({ length: 10 }, (_, i) => `mcp-${i + 1}`),
    alerting: Array.from({ length: 8 }, (_, i) => `alerting-${i + 1}`),
    viz: Array.from({ length: 7 }, (_, i) => `viz-${i + 1}`),
};

/** Table rows: | ID | Line | Assumption | Decision | ... */
function rows(text: string): Map<string, { line: string; assumption: string; decision: string }> {
    const out = new Map();
    for (const raw of text.split('\n')) {
        const cells = raw.split('|').map((c) => c.trim());
        if (cells.length < 6 || !/^[a-z]+-(A?\d+|log-\d+)$/.test(cells[1])) continue;
        out.set(cells[1], { line: cells[2], assumption: cells[3], decision: cells[4] });
    }
    return out;
}

describe('int-assumptions-register', () => {
    it('has a decided row for every assumption of every line', () => {
        expect(fs.existsSync(DOC)).toBe(true);
        const table = rows(fs.readFileSync(DOC, 'utf8'));
        for (const [line, ids] of Object.entries(NUMBERED)) {
            for (const id of ids) {
                const row = table.get(id);
                expect(row, `${id} is missing`).toBeDefined();
                expect(row.line, id).toBe(line);
                expect(row.assumption.length, `${id} assumption text`).toBeGreaterThan(15);
                expect(row.decision, `${id} decision`).toMatch(/^(Kept|Changed|Superseded)\b/);
                expect(row.decision.length, `${id} decision text`).toBeGreaterThan(12);
            }
        }
        // Assumptions recorded inside session logs rather than in the numbered lists.
        const logRows = [...table.keys()].filter((id) => /-log-\d+$/.test(id));
        for (const line of ['ldq', 'mcp', 'alerting']) {
            expect(logRows.filter((id) => id.startsWith(`${line}-log-`)).length, `${line} session-log assumptions`).toBeGreaterThanOrEqual(3);
        }
        for (const id of logRows) expect(table.get(id).decision, id).toMatch(/^(Kept|Changed|Superseded)\b/);

        const changed = (id: string) => /^Changed\b/.test(table.get(id)?.decision ?? '');
        // Confirmation tokens: the MCP's own shape loses; Lightdash and the engine agree on one encoding.
        expect(changed('mcp-4')).toBe(true);
        expect(changed('engine-A6') || changed('ldq-3')).toBe(true);
        // CloudWatch metric_data_query shape.
        expect(changed('engine-A19') || changed('ldq-8')).toBe(true);
        // Alerting API filters used by the MCP alert tools.
        expect(changed('mcp-2') || changed('alerting-5')).toBe(true);
        // The evaluator identity seam is wired.
        expect(changed('alerting-1')).toBe(true);
    });

    it('names the fix feature for every Changed decision', () => {
        const text = fs.readFileSync(DOC, 'utf8');
        const table = rows(text);
        const fixIds = fs
            .readdirSync(path.join(REPO_ROOT, 'e2e/eng-1799/acceptance'))
            .filter((f) => f.startsWith('int-fix-') && f.endsWith('.test.ts'))
            .map((f) => f.replace(/\.test\.ts$/, ''));
        for (const [id, row] of table) {
            if (/^Changed\b/.test(row.decision)) expect(row.decision, id).toMatch(/int-fix-[a-z0-9-]+/);
        }
        for (const fix of fixIds) expect(text, fix).toContain(fix);
    });
});
