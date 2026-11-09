/* eslint-disable */
// @ts-nocheck
// int-contracts-amended: where the contract itself was ambiguous, CONTRACTS.md now says what the
// integration line decided, in dated amendment notes: the Write Mode confirmation token encoding
// (§4.2), the accepted cloudwatch() metric_data_query shapes (§1.1), how reserved time parameters
// are written in SQL (§2), and the system identity's attrs configuration (§4.3).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from './support';

const section = (text: string, heading: RegExp) => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => heading.test(l));
    if (start < 0) return '';
    const level = /^#+/.exec(lines[start])![0].length;
    const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && /^#+/.exec(l)![0].length <= level);
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
};

describe('int-contracts-amended', () => {
    it('records the reconciled readings as dated amendments', () => {
        const text = fs.readFileSync(path.join(REPO_ROOT, 'docs/eng-1799/CONTRACTS.md'), 'utf8');
        const amendments = [...text.matchAll(/[Aa]mended (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
        const integrationDates = amendments.filter((d) => d >= '2026-11-08');
        expect(integrationDates.length).toBeGreaterThanOrEqual(5); // 4.1's original note plus four of ours

        const write = section(text, /^### 4\.2 /);
        expect(write).toMatch(/[Aa]mended \d{4}-\d{2}-\d{2}/);
        for (const key of ['typ', 'write_confirmation', 'statement_sha256', 'iat', 'nonce']) expect(write, key).toContain(key);

        const functions = section(text, /^### 1\.1 /);
        expect(functions).toMatch(/[Aa]mended \d{4}-\d{2}-\d{2}/);
        expect(functions).toMatch(/metricEditorMode|Grafana/);
        expect(functions).toContain('MetricStat');

        const time = section(text, /^## 2\. /);
        expect(time).toMatch(/[Aa]mended \d{4}-\d{2}-\d{2}/);
        expect(time).toContain('${ld.parameters.__from}');
        expect(time).toMatch(/quot/i);

        const alerts = section(text, /^### 4\.3 /);
        expect(alerts).toMatch(/[Aa]mended \d{4}-\d{2}-\d{2}/);
        expect(alerts).toContain('ALERTING_EVALUATOR_ATTRS');
    });
});
