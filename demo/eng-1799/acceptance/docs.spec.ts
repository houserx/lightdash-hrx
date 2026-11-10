// demo-docs. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, SCENES } from './helpers/stack';

test('demo-docs: docs/eng-1799/demo.md covers prerequisites, the one command, presenting live, the timeline, the scenes and licensed music', () => {
    const doc = readFileSync(path.join(ROOT, 'docs', 'eng-1799', 'demo.md'), 'utf8');
    const headings = doc.split('\n').filter((l) => /^#{1,3}\s/.test(l)).join('\n').toLowerCase();
    for (const h of ['prerequisites', 'one command', 'present', 'timeline', 'scene', 'music']) expect(headings, `a heading about "${h}"`).toContain(h);

    expect(doc).toContain('demo/eng-1799/run-all.sh');
    expect(doc).toContain('--keep');
    expect(doc).toContain('demo/eng-1799/up.sh');
    expect(doc).toContain('demo/eng-1799/down.sh');
    expect(doc).toContain('pnpm -F eng-1799-demo video');
    expect(doc).toContain('--music');
    expect(doc).toMatch(/licen[cs]e/i);
    expect(doc).toMatch(/DEMO_INCIDENT_AT/);
    expect(doc).toMatch(/DEMO_RECOVERY_AT/);
    expect(doc).toMatch(/T\s*\+\s*90\s*s/i);
    expect(doc).toMatch(/T\s*\+\s*5\s*min/i);
    for (const s of SCENES) expect(doc, `scene ${s}`).toContain(s);
    expect(doc).toMatch(/production build|dev server/i);
    // glossary: never the _Avoid_ terms for the things the demo shows
    expect(doc).not.toMatch(/\b(datasource|dry run|prod db|notification policy)\b/i);
    expect(doc).not.toMatch(/dashboard panel/i);
});
